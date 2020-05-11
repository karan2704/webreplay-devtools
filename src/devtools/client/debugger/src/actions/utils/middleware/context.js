/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// @flow

import {
  validateNavigateContext,
  validateContext,
} from "../../../utils/context";

import type { ThunkArgs } from "../../types";

const { log } = require("protocol/socket");

function validateActionContext(getState, action) {
  if (action.type == "COMMAND" && action.status == "done") {
    // The thread will have resumed execution since the action was initiated,
    // so just make sure we haven't navigated.
    validateNavigateContext(getState(), action.cx);
    return;
  }

  // Validate using all available information in the context.
  validateContext(getState(), action.cx);
}

function actionLogData(action) {
  switch (action.type) {
    case "COMMAND":
      return " " + action.command;
    case "PAUSED":
      return " " + JSON.stringify(action.executionPoint);
  }
  return "";
}

function logAction(action) {
  if (action.type == "BATCH") {
    action.updates.forEach(logAction);
  } else {
    const data = actionLogData(action);
    const status = action.status ? ` [${action.status}]` : "";
    log(`Debugger ${action.type}${data}${status}`);
  }
}

// Middleware which looks for actions that have a cx property and ignores
// them if the context is no longer valid.
function context({ dispatch, getState }: ThunkArgs) {
  return (next: Function) => (action: Object) => {
    if ("cx" in action) {
      validateActionContext(getState, action);
    }

    logAction(action);

    return next(action);
  };
}

export { context };