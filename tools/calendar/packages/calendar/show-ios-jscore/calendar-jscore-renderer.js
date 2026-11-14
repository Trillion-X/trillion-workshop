// Purpose: pure Calendar model-to-native-screen renderer for JavaScriptCore.
// Invariant: consumes Calendar interval/action data and emits generic screen
// snapshot nodes; it does not import browser UI globals or source-owner code.

(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value, fallback) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback || '';
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function node(kind, props, children, id) {
    var result = {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children)
    };
    if (id) result.id = id;
    return result;
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: readString(value),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function stack(axis, spacing, children, props) {
    return node('stack', Object.assign({ axis: axis || 'vertical', spacing: spacing || 0 }, objectOrEmpty(props)), children);
  }

  function colorDot(color) {
    return node('box', {
      background: readString(color, 'accent'),
      cornerRadius: 5,
      width: 10,
      height: 10,
      fillWidth: false
    }, []);
  }

  function chip(label, color, trailing) {
    var children = [colorDot(color), text(label, 12, 'semibold', 'darkTextPrimary', 1)];
    if (trailing) children.push(text(trailing, 11, 'regular', 'darkTextSecondary', 1));
    return node('box', {
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 9,
      fillWidth: false
    }, [stack('horizontal', 7, children)]);
  }

  function humanize(value, fallback) {
    var raw = readString(value, fallback || '');
    if (!raw) return '';
    return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (letter) {
      return letter.toUpperCase();
    });
  }

  function normalizeAction(raw) {
    var action = objectOrEmpty(raw);
    var id = readString(action.id);
    var target = readString(action.target);
    var definitionId = readString(action.definition_id || action.definitionId);
    if (!id || !target || !definitionId) return null;
    return {
      id: id,
      label: readString(action.label, humanize(id, 'Action')),
      target: target,
      definition_id: definitionId,
      include_output: readBoolean(action.include_output || action.includeOutput, false),
      input: objectOrEmpty(action.input),
      disabledReason: readString(action.disabledReason || action.disabled_reason)
    };
  }

  function actionPress(action, extraInput) {
    var input = Object.assign({}, action.input, objectOrEmpty(extraInput), {
      action_id: action.id,
      correlation_id: 'calendar-action:' + action.id
    });
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: action.target,
        payload: {
          operation: 'execute_definition',
          definition_id: action.definition_id,
          include_steps: false,
          include_output: action.include_output,
          input: input
        }
      }
    };
  }

  function actionButton(action, extraInput, accent) {
    return node('box', {
      background: accent ? '#113825' : 'darkSurfaceRaised',
      border: accent ? '#2dd47a' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 11,
      fillWidth: false,
      disabled: !!action.disabledReason,
      disabledReason: action.disabledReason || '',
      press: action.disabledReason ? null : actionPress(action, extraInput)
    }, [text(action.label, 12, 'semibold', accent ? '#8af2ba' : 'darkTextPrimary', 1)]);
  }

  function normalizeAccount(raw, index) {
    var account = objectOrEmpty(raw);
    var id = readString(account.id, 'account-' + String(index + 1));
    var label = readString(account.label || account.name, 'Calendar');
    var color = readString(account.color, '#2563eb');
    var status = readString(account.status, 'ready');
    return {
      id: id,
      label: label,
      color: color,
      status: status,
      statusLabel: readString(account.statusLabel || account.status_label, humanize(status, 'Ready')),
      visible: readBoolean(account.visible, true),
      calendars: arrayOrEmpty(account.calendars),
      actions: arrayOrEmpty(account.actions).map(normalizeAction).filter(Boolean)
    };
  }

  function normalizeBlock(raw, index) {
    var block = objectOrEmpty(raw);
    var interval = objectOrEmpty(block.interval);
    var display = objectOrEmpty(block.display);
    var state = objectOrEmpty(block.state);
    var id = readString(block.id, 'block-' + String(index + 1));
    return {
      id: id,
      title: readString(display.title || block.title || block.label, 'Untitled event'),
      color: readString(display.color || block.color, '#2563eb'),
      ownerLabel: readString(display.ownerLabel || display.owner_label),
      start: readString(interval.start || block.start || block.starts_at),
      end: readString(interval.end || block.end || block.ends_at),
      allDay: readBoolean(interval.allDay || interval.all_day, false),
      state: readString(state.ref || block.state_ref || block.status, 'ready'),
      lane: readString(state.lane || block.lane_ref),
      relations: objectOrEmpty(block.relations),
      actions: arrayOrEmpty(block.actions).map(normalizeAction).filter(Boolean)
    };
  }

  function sortBlocks(blocks) {
    return blocks.slice().sort(function (left, right) {
      return left.start.localeCompare(right.start) || left.end.localeCompare(right.end) || left.id.localeCompare(right.id);
    });
  }

  function deriveState(input, accounts, blocks) {
    var explicit = readString(input.state || input.status);
    if (explicit === 'empty-no-accounts' && accounts.length > 0) explicit = '';
    if (explicit) return explicit;
    if (accounts.length === 0) return 'empty-no-accounts';
    if (blocks.length === 0) return 'empty-connected';
    return blocks.length > 6 ? 'dense' : 'sparse';
  }

  function normalizeModel(value) {
    var input = Array.isArray(value) ? { blocks: value } : objectOrEmpty(value);
    var accounts = arrayOrEmpty(input.accounts).map(normalizeAccount);
    var blocks = sortBlocks(arrayOrEmpty(input.blocks || input.timeBlocks).map(normalizeBlock));
    var selectedId = readString(input.selectedBlockId || input.selected_block_id);
    var selected = null;
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].id === selectedId) selected = blocks[i];
    }
    if (!selected) selected = blocks[0] || null;
    var actions = arrayOrEmpty(input.actions).map(normalizeAction).filter(Boolean);
    if (!actions.length && selected) actions = selected.actions;
    return {
      title: readString(input.title, 'Calendar'),
      dateLabel: readString(input.dateLabel || input.date_label, 'Today'),
      timezone: readString(input.timezone, 'Local time'),
      viewMode: readString(input.viewMode || input.view_mode, 'agenda'),
      renderMode: 'mobile',
      rangeStart: readString(input.rangeStart || input.range_start),
      rangeEnd: readString(input.rangeEnd || input.range_end),
      accounts: accounts,
      blocks: blocks,
      selectedBlockId: selected ? selected.id : null,
      selectedBlock: selected,
      actions: actions,
      issues: arrayOrEmpty(input.issues).map(function (issue, index) {
        var item = objectOrEmpty(issue);
        return {
          id: readString(item.id, 'issue-' + String(index + 1)),
          tone: readString(item.tone, 'info'),
          label: readString(item.label, 'Calendar needs attention'),
          detail: readString(item.detail),
          action: normalizeAction(item.action)
        };
      }),
      state: deriveState(input, accounts, blocks)
    };
  }

  function formatTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return value;
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var suffix = hours >= 12 ? 'PM' : 'AM';
    var hour12 = hours % 12 || 12;
    return String(hour12) + ':' + String(minutes).padStart(2, '0') + ' ' + suffix;
  }

  function dateKey(value) {
    if (!value) return 'No date';
    var date = new Date(value);
    if (isNaN(date.getTime())) return 'No date';
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function dateLabel(value) {
    var key = dateKey(value);
    if (key === 'No date') return key;
    var parts = key.split('-');
    return parts[1] + '/' + parts[2] + '/' + parts[0];
  }

  function blockTimeLabel(block) {
    if (block.allDay) return 'All day';
    var start = formatTime(block.start);
    var end = formatTime(block.end);
    if (start && end) return start + ' - ' + end;
    return start || end || 'Time not set';
  }

  function stateLabel(block) {
    return humanize(block.state, 'Saved');
  }

  function accountRail(model) {
    if (!model.accounts.length) {
      return node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 14
      }, [
        text('No calendars connected', 15, 'semibold', 'darkTextPrimary', 2),
        text('Connect an account to see events here.', 12, 'regular', 'darkTextSecondary', 3)
      ]);
    }
    return stack('horizontal', 8, model.accounts.map(function (account) {
      return chip(account.label, account.color, account.statusLabel);
    }), { horizontalScroll: true });
  }

  function issuePanel(model) {
    if (!model.issues.length) return null;
    return stack('vertical', 8, model.issues.map(function (issue) {
      var children = [
        text(issue.label, 13, 'semibold', issue.tone === 'error' ? '#ff8f8f' : 'darkTextPrimary', 2)
      ];
      if (issue.detail) children.push(text(issue.detail, 12, 'regular', 'darkTextSecondary', 3));
      if (issue.action) children.push(actionButton(issue.action, {}, false));
      return node('box', {
        background: 'darkSurfaceRaised',
        border: issue.tone === 'error' ? '#ff6b6b' : 'darkBorder',
        borderWidth: 1,
        cornerRadius: 16,
        padding: 12
      }, children);
    }));
  }

  function eventCard(block, selected) {
    var children = [
      stack('horizontal', 8, [
        colorDot(block.color),
        text(blockTimeLabel(block), 12, 'medium', 'darkTextSecondary', 1),
        text(stateLabel(block), 11, 'regular', selected ? '#8af2ba' : 'darkTextSecondary', 1)
      ]),
      text(block.title, 16, 'semibold', 'darkTextPrimary', 2)
    ];
    if (block.ownerLabel) children.push(text(block.ownerLabel, 12, 'regular', 'darkTextSecondary', 1));
    return node('box', {
      background: selected ? '#12283a' : 'darkSurfaceRaised',
      border: selected ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 13,
      press: {
        operation: SNAPSHOT_REPLACE_OPERATION,
        payload: null
      }
    }, children, block.id);
  }

  function agenda(model) {
    if (!model.blocks.length) {
      var message = model.accounts.length ? 'No events in this range.' : 'Calendar is ready when an account is connected.';
      return node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 18
      }, [text(message, 16, 'semibold', 'darkTextPrimary', 3)]);
    }

    var groups = {};
    for (var i = 0; i < model.blocks.length; i += 1) {
      var block = model.blocks[i];
      var key = dateKey(block.start);
      if (!groups[key]) groups[key] = [];
      groups[key].push(block);
    }
    var sections = Object.keys(groups).sort().map(function (key) {
      var cards = groups[key].map(function (block) {
        return eventCard(block, block.id === model.selectedBlockId);
      });
      return stack('vertical', 8, [text(key === 'No date' ? key : dateLabel(groups[key][0].start), 13, 'bold', 'darkTextSecondary', 1)].concat(cards));
    });
    return stack('vertical', 14, sections);
  }

  function detailPanel(model) {
    var block = model.selectedBlock;
    if (!block) {
      return node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 20,
        padding: 16
      }, [
        text('Details', 15, 'bold', 'darkTextPrimary', 1),
        text('Select an event to inspect it.', 12, 'regular', 'darkTextSecondary', 2)
      ]);
    }

    var children = [
      stack('horizontal', 8, [colorDot(block.color), text(stateLabel(block), 12, 'semibold', 'darkTextSecondary', 1)]),
      text(block.title, 20, 'bold', 'darkTextPrimary', 3),
      text(blockTimeLabel(block), 13, 'regular', 'darkTextSecondary', 1)
    ];
    var actions = block.actions.length ? block.actions : model.actions;
    if (actions.length) {
      children.push(stack('horizontal', 8, actions.slice(0, 4).map(function (action, index) {
        return actionButton(action, { block_ref: block.id }, index === 0);
      }), { wrap: true }));
    }
    return node('box', {
      background: '#101820',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 22,
      padding: 16
    }, children);
  }

  function modeSelector(model) {
    var modes = ['day', 'week', 'month', 'agenda'];
    return stack('horizontal', 7, modes.map(function (mode) {
      return node('box', {
        background: model.viewMode === mode ? '#14243a' : 'darkSurfaceRaised',
        border: model.viewMode === mode ? 'accent' : 'darkBorder',
        borderWidth: 1,
        cornerRadius: 14,
        padding: 10,
        fillWidth: false
      }, [text(humanize(mode), 11, 'semibold', model.viewMode === mode ? 'accent' : 'darkTextSecondary', 1)]);
    }));
  }

  function topActions(model) {
    if (!model.actions.length) return null;
    return stack('horizontal', 8, model.actions.slice(0, 4).map(function (action, index) {
      return actionButton(action, {}, index === 0);
    }), { horizontalScroll: true });
  }

  function buildSnapshot(model, lifecycleKey) {
    var issue = issuePanel(model);
    var top = topActions(model);
    var children = [
      text(model.title, 30, 'bold', 'darkTextPrimary', 2),
      text(model.dateLabel + ' · ' + model.timezone, 13, 'regular', 'darkTextSecondary', 2),
      accountRail(model),
      modeSelector(model)
    ];
    if (top) children.push(top);
    if (issue) children.push(issue);
    children.push(agenda(model));
    children.push(detailPanel(model));
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: lifecycleKey || 'component:calendar:jscore',
      summary: {
        state: model.state,
        account_count: model.accounts.length,
        block_count: model.blocks.length,
        action_count: model.actions.length,
        selected_block_id: model.selectedBlockId
      },
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 20,
        spacing: 14
      }, children)
    };
  }

  function renderCalendarNativeSnapshot(value, lifecycleKey) {
    var model = normalizeModel(value);
    return buildSnapshot(model, lifecycleKey);
  }

  globalThis.CalendarJscoreRenderer = {
    normalizeModel: normalizeModel,
    renderCalendarNativeSnapshot: renderCalendarNativeSnapshot,
    actionPress: actionPress
  };
}());
