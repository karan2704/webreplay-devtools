/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// @flow

import { prepareSourcePayload, createThread, createFrame } from "./create";
import { updateTargets } from "./targets";
import { clientEvents, eventMethods } from "./events";

import Reps from "devtools-reps";
import type { Node } from "devtools-reps";

import type {
  ActorId,
  BreakpointLocation,
  BreakpointOptions,
  PendingLocation,
  Frame,
  FrameId,
  GeneratedSourceData,
  Script,
  SourceId,
  SourceActor,
  Range,
  ExecutionPoint,
} from "../../types";

import type {
  EventListenerCategoryList,
  EventListenerActiveList,
} from "../../actions/types";

const { ThreadFront } = require("protocol/thread");

let targets: { [string]: Target };
let currentThreadFront: ThreadFront;
let currentTarget: Target;
let devToolsClient: DevToolsClient;
let sourceActors: { [ActorId]: SourceId };
let breakpoints: { [string]: Object };
let eventBreakpoints: ?EventListenerActiveList;

const CALL_STACK_PAGE_SIZE = 1000;

type Dependencies = {
  devToolsClient: DevToolsClient,
};

function setupCommands(dependencies: Dependencies) {
  devToolsClient = dependencies.devToolsClient;
  targets = {};
  sourceActors = {};
  breakpoints = {};
}

function setupCommandsTopTarget(targetFront: Target) {
  currentTarget = targetFront;
  currentThreadFront = targetFront.threadFront;
}

function createObjectFront(grip: Grip): ObjectFront {
  if (!grip.actor) {
    throw new Error("Actor is missing");
  }

  return devToolsClient.createObjectFront(grip, currentThreadFront);
}

async function loadObjectProperties(root: Node) {
  const utils = Reps.objectInspector.utils;
  const properties = await utils.loadProperties.loadItemProperties(
    root,
    devToolsClient
  );
  return utils.node.getChildren({
    item: root,
    loadedProperties: new Map([[root.path, properties]]),
  });
}

function releaseActor(actor: String) {
  // Object fronts are always thread scoped with web replay.
  return;

  /*
  if (!actor) {
    return;
  }
  const objFront = devToolsClient.getFrontByID(actor);

  if (objFront) {
    return objFront.release().catch(() => {});
  }
  */
}

function sendPacket(packet: Object) {
  return devToolsClient.request(packet);
}

// Get a copy of the current targets.
function getTargetsMap(): { string: Target } {
  return Object.assign({}, targets);
}

function listThreadFronts() {
  const targetList = (Object.values(getTargetsMap()): any);
  return targetList.map(target => target.threadFront).filter(t => !!t);
}

function forEachThread(iteratee) {
  return iteratee(ThreadFront);
}

function resume(thread: string): Promise<*> {
  return lookupThreadFront(thread).resume();
}

function stepIn(thread: string): Promise<*> {
  return lookupThreadFront(thread).stepIn();
}

function stepOver(thread: string): Promise<*> {
  return lookupThreadFront(thread).stepOver();
}

function stepOut(thread: string): Promise<*> {
  return lookupThreadFront(thread).stepOut();
}

function rewind(thread: string): Promise<*> {
  return lookupThreadFront(thread).rewind();
}

function reverseStepOver(thread: string): Promise<*> {
  return lookupThreadFront(thread).reverseStepOver();
}

function breakOnNext(thread: string): Promise<*> {
  return lookupThreadFront(thread).breakOnNext();
}

async function sourceContents({
  actor,
  thread,
}: SourceActor): Promise<{| source: any, contentType: ?string |}> {
  const { scriptSource, contentType } = await ThreadFront.getScriptSource(actor);
  return { source: scriptSource, contentType };
}

function setXHRBreakpoint(path: string, method: string) {
  return currentThreadFront.setXHRBreakpoint(path, method);
}

function removeXHRBreakpoint(path: string, method: string) {
  return currentThreadFront.removeXHRBreakpoint(path, method);
}

function addWatchpoint(
  object: Grip,
  property: string,
  label: string,
  watchpointType: string
) {
  if (currentTarget.traits.watchpoints) {
    const objectFront = createObjectFront(object);
    return objectFront.addWatchpoint(property, label, watchpointType);
  }
}

async function removeWatchpoint(object: Grip, property: string) {
  if (currentTarget.traits.watchpoints) {
    const objectFront = createObjectFront(object);
    await objectFront.removeWatchpoint(property);
  }
}

// Get the string key to use for a breakpoint location.
// See also duplicate code in breakpoint-actor-map.js :(
function locationKey(location: BreakpointLocation) {
  const { sourceUrl, line, column } = location;
  const sourceId = location.sourceId || "";
  // $FlowIgnore
  return `${sourceUrl}:${sourceId}:${line}:${column}`;
}

function maybeGenerateLogGroupId(options) {
  if (
    options.logValue &&
    currentTarget.traits &&
    currentTarget.traits.canRewind
  ) {
    return { ...options, logGroupId: `logGroup-${Math.random()}` };
  }
  return options;
}

async function maybeClearLogpoint(location: BreakpointLocation) {
  const bp = breakpoints[locationKey(location)];
  if (bp && bp.options.logGroupId && currentTarget) {
    const consoleFront = await currentTarget.getFront("console");
    consoleFront.emit("clearLogpointMessages", bp.options.logGroupId);
  }
}

function hasBreakpoint(location: BreakpointLocation) {
  return !!breakpoints[locationKey(location)];
}

function setBreakpoint(
  location: BreakpointLocation,
  options: BreakpointOptions
) {
  maybeClearLogpoint(location);
  options = maybeGenerateLogGroupId(options);
  breakpoints[locationKey(location)] = { location, options };

  const { condition, logValue } = options;
  if (logValue) {
    throw new Error("NYI");
  }

  const { line, column, sourceUrl, sourceId } = location;
  if (sourceId) {
    return forEachThread(thread => thread.setBreakpoint(sourceId, line, column, condition));
  }
  return forEachThread(thread => thread.setBreakpointByURL(sourceUrl, line, column, condition));
}

function removeBreakpoint(location: PendingLocation) {
  maybeClearLogpoint((location: any));
  delete breakpoints[locationKey((location: any))];

  const { line, column, sourceUrl, sourceId } = location;
  if (sourceId) {
    return forEachThread(thread => thread.removeBreakpoint(sourceId, line, column));
  }
  return forEachThread(thread => thread.removeBreakpointByURL(sourceUrl, line, column));
}

function evaluateInFrame(
  script: Script,
  options: EvaluateParam
): Promise<{ result: ExpressionResult }> {
  return evaluate(script, options);
}

async function evaluateExpressions(scripts: Script[], options: EvaluateParam) {
  return Promise.all(scripts.map(script => evaluate(script, options)));
}

type EvaluateParam = { thread: string, frameId: ?FrameId };

async function evaluate(
  script: ?Script,
  { thread, frameId }: EvaluateParam = {}
): Promise<{ result: ExpressionResult }> {
  const params = { thread, frameActor: frameId };
  if (!currentTarget || !script) {
    return { result: null };
  }

  const target = thread ? lookupTarget(thread) : currentTarget;
  const consoleFront = await target.getFront("console");
  if (!consoleFront) {
    return { result: null };
  }

  return consoleFront.evaluateJSAsync(script, params);
}

async function autocomplete(
  input: string,
  cursor: number,
  frameId: ?string
): Promise<mixed> {
  if (!currentTarget || !input) {
    return {};
  }
  const consoleFront = await currentTarget.getFront("console");
  if (!consoleFront) {
    return {};
  }

  return new Promise(resolve => {
    consoleFront.autocomplete(
      input,
      cursor,
      result => resolve(result),
      frameId
    );
  });
}

function navigate(url: string): Promise<*> {
  return currentTarget.navigateTo({ url });
}

function reload(): Promise<*> {
  return currentTarget.reload();
}

function getProperties(thread: string, grip: Grip): Promise<*> {
  const objClient = lookupThreadFront(thread).pauseGrip(grip);

  return objClient.getPrototypeAndProperties().then(resp => {
    const { ownProperties, safeGetterValues } = resp;
    for (const name in safeGetterValues) {
      const { enumerable, writable, getterValue } = safeGetterValues[name];
      ownProperties[name] = { enumerable, writable, value: getterValue };
    }
    return resp;
  });
}

async function getFrames(thread: string) {
  const threadFront = lookupThreadFront(thread);
  const response = await threadFront.getFrames(0, CALL_STACK_PAGE_SIZE);
  return response.frames.map<?Frame>((frame, i) =>
    createFrame(thread, frame, i)
  );
}

async function getFrameScopes(frame: Frame): Promise<*> {
  return lookupThreadFront(frame.thread).getEnvironment(frame.id);
}

function pauseOnExceptions(
  shouldPauseOnExceptions: boolean,
  shouldPauseOnCaughtExceptions: boolean
): Promise<*> {
  return forEachThread(thread =>
    thread.pauseOnExceptions(
      shouldPauseOnExceptions,
      // Providing opposite value because server
      // uses "shouldIgnoreCaughtExceptions"
      !shouldPauseOnCaughtExceptions
    )
  );
}

async function blackBox(
  sourceActor: SourceActor,
  isBlackBoxed: boolean,
  range?: Range
): Promise<*> {
  const sourceFront = currentThreadFront.source({ actor: sourceActor.actor });
  if (isBlackBoxed) {
    await sourceFront.unblackBox(range);
  } else {
    await sourceFront.blackBox(range);
  }
}

function setSkipPausing(shouldSkip: boolean) {
  return forEachThread(thread => thread.setSkipPausing(shouldSkip));
}

function interrupt(thread: string): Promise<*> {
  return lookupThreadFront(thread).interrupt();
}

function setEventListenerBreakpoints(ids: string[]) {
  eventBreakpoints = ids;

  return forEachThread(thread => thread.setActiveEventBreakpoints(ids));
}

// eslint-disable-next-line
async function getEventListenerBreakpointTypes(): Promise<EventListenerCategoryList> {
  let categories;
  try {
    categories = await currentThreadFront.getAvailableEventBreakpoints();

    if (!Array.isArray(categories)) {
      // When connecting to older browser that had our placeholder
      // implementation of the 'getAvailableEventBreakpoints' endpoint, we
      // actually get back an object with a 'value' property containing
      // the categories. Since that endpoint wasn't actually backed with a
      // functional implementation, we just bail here instead of storing the
      // 'value' property into the categories.
      categories = null;
    }
  } catch (err) {
    // Event bps aren't supported on this firefox version.
  }
  return categories || [];
}

function pauseGrip(thread: string, func: Function): ObjectFront {
  return lookupThreadFront(thread).pauseGrip(func);
}

function registerSourceActor(sourceActorId: string, sourceId: SourceId, url) {
  sourceActors[sourceActorId] = sourceId;
  eventMethods.onSourceActorRegister(sourceActorId);
}

async function getSources(
  client: ThreadFront
): Promise<Array<GeneratedSourceData>> {
  const { sources }: SourcesPacket = await client.getSources();

  return sources.map(source => prepareSourcePayload(client, source));
}

async function toggleEventLogging(logEventBreakpoints: boolean) {
  return forEachThread(thread =>
    thread.toggleEventLogging(logEventBreakpoints)
  );
}

function getAllThreadFronts() {
  const fronts = [currentThreadFront];
  for (const { threadFront } of (Object.values(targets): any)) {
    fronts.push(threadFront);
  }
  return fronts;
}

// Fetch the sources for all the targets
async function fetchSources(): Promise<Array<GeneratedSourceData>> {
  let sources = [];
  for (const threadFront of getAllThreadFronts()) {
    sources = sources.concat(await getSources(threadFront));
  }
  return sources;
}

async function fetchThreadSources(
  thread: string
): Promise<Array<GeneratedSourceData>> {
  return getSources(lookupThreadFront(thread));
}

// Check if any of the targets were paused before we opened
// the debugger. If one is paused. Fake a `pause` RDP event
// by directly calling the client event listener.
async function checkIfAlreadyPaused() {
  for (const threadFront of getAllThreadFronts()) {
    const pausedPacket = threadFront.getLastPausePacket();
    if (pausedPacket) {
      clientEvents.paused(threadFront, pausedPacket);
    }
  }
}

function getSourceForActor(actor: ActorId) {
  if (!sourceActors[actor]) {
    throw new Error(`Unknown source actor: ${actor}`);
  }
  return sourceActors[actor];
}

async function fetchThreads() {
  const options = {
    breakpoints,
    eventBreakpoints,
    observeAsmJS: true,
  };

  await updateTargets({
    currentTarget,
    devToolsClient,
    targets,
    options,
  });

  // eslint-disable-next-line
  return (Object.entries(targets).map: any)(([actor, target]) =>
    createThread((actor: any), (target: any))
  );
}

function getMainThread() {
  return currentThreadFront.actor;
}

async function getSourceActorBreakpointPositions(
  { thread, actor }: SourceActor,
  range: Range
): Promise<{ [number]: number[] }> {
  const linePositions = await ThreadFront.getBreakpointPositionsCompressed(actor, range);
  const rv = {};
  linePositions.forEach(({ line, columns }) => (rv[line] = columns));
  return rv;
}

async function getSourceActorBreakableLines({
  thread,
  actor,
}: SourceActor): Promise<Array<number>> {
  const positions = await ThreadFront.getBreakpointPositionsCompressed(actor);
  return positions.map(({ line }) => line);
}

function getFrontByID(actorID: String) {
  return devToolsClient.getFrontByID(actorID);
}

function timeWarp(position: ExecutionPoint) {
  currentThreadFront.timeWarp(position);
}

function instantWarp(point: ExecutionPoint) {
  currentThreadFront.instantWarp(point);
  currentThreadFront.emit("instantWarp", { executionPoint: point });
}

function fetchAncestorFramePositions(index: number) {
  return currentThreadFront.fetchAncestorFramePositions(index);
}

function pickExecutionPoints(count: number, options) {
  return currentThreadFront.pickExecutionPoints(count, options);
}

const clientCommands = {
  autocomplete,
  blackBox,
  createObjectFront,
  loadObjectProperties,
  releaseActor,
  interrupt,
  pauseGrip,
  resume,
  stepIn,
  stepOut,
  stepOver,
  rewind,
  reverseStepOver,
  breakOnNext,
  sourceContents,
  getSourceForActor,
  getSourceActorBreakpointPositions,
  getSourceActorBreakableLines,
  hasBreakpoint,
  setBreakpoint,
  setXHRBreakpoint,
  removeXHRBreakpoint,
  addWatchpoint,
  removeWatchpoint,
  removeBreakpoint,
  evaluate,
  evaluateInFrame,
  evaluateExpressions,
  navigate,
  reload,
  getProperties,
  getFrameScopes,
  getFrames,
  pauseOnExceptions,
  toggleEventLogging,
  fetchSources,
  fetchThreadSources,
  checkIfAlreadyPaused,
  registerSourceActor,
  fetchThreads,
  getMainThread,
  sendPacket,
  setSkipPausing,
  setEventListenerBreakpoints,
  getEventListenerBreakpointTypes,
  getFrontByID,
  timeWarp,
  instantWarp,
  fetchAncestorFramePositions,
  pickExecutionPoints,
  eventMethods,
};

export { setupCommands, setupCommandsTopTarget, clientCommands };