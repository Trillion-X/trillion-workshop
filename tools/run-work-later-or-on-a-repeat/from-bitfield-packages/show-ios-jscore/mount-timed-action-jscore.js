// Purpose: JavaScriptCore realization entry for timed-action.
// Invariants: no React, DOM, browser storage, provider clients, adjacent package
// imports, or iOS-only backend schema. The mount consumes the same folded
// scheduled-action projection contract as the browser surface and emits sealed
// native snapshot / generic owner-action operations.

(function () {
  var PACKAGE_NAME = 'timed-action';
  var INPUT_NAME = 'scheduled-action-view';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var DEFAULT_OPERATION = 'invoke';
  var DEFAULT_LIFECYCLE_KEY = 'component:timed-action:jscore';

  var STATUS_OVERRIDES = {
    scheduled: { label: 'Scheduled', tone: 'info' },
    due: { label: 'Due now', tone: 'warning' },
    unscheduled: { label: 'Not scheduled', tone: 'neutral' },
    draft: { label: 'Draft', tone: 'neutral' },
    changes_requested: { label: 'Changes requested', tone: 'warning' },
    publishing: { label: 'Publishing', tone: 'info' },
    partially_published: { label: 'Some channels published', tone: 'warning' },
    published: { label: 'Published', tone: 'success', isTerminal: true },
    failed: { label: "Couldn't publish", tone: 'error', isTerminal: true, isError: true },
    disconnected: { label: 'Account needs reconnecting', tone: 'error', isError: true },
    canceled: { label: 'Canceled', tone: 'neutral', isTerminal: true },
    completed: { label: 'Done', tone: 'success', isTerminal: true }
  };

  var COPY = {
    empty: {
      title: 'No posts scheduled',
      body: 'Schedule your first post to see it on the calendar and in the queue.',
      primaryAction: 'New post',
      secondaryAction: 'Import draft'
    },
    loading: {
      title: 'Loading your schedule',
      body: 'Bringing in your posts, channels, and approvals.'
    },
    error: {
      title: "We couldn't load your schedule",
      body: 'Your posts are safe. Try again in a moment.',
      recoveryAction: 'Try again'
    },
    modes: { calendar: 'Calendar', queue: 'Queue' }
  };

  var FALLBACKS = {
    channel: 'This channel',
    account: 'This account',
    metric: 'Metric',
    target: 'This destination',
    campaign: 'This campaign',
    blocker: 'Needs attention',
    action: 'Continue',
    group: 'Other',
    post: 'This post',
    field: 'Detail'
  };

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

  function cleanKey(value) {
    var string = readString(value);
    return string || null;
  }

  function looksLikeRawId(value) {
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(value)) return true;
    if (value.indexOf('::') >= 0) return true;
    if (/\b(payload|fact|envelope|slot|descriptor|address)\b/i.test(value)) return true;
    if (/(^|\s)(ref|package)\b/i.test(value)) return true;
    if (!/\s/.test(value) && (value.indexOf(':') >= 0 || /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(value))) return true;
    return false;
  }

  function cleanLabel(value) {
    var label = readString(value);
    if (!label) return null;
    return looksLikeRawId(label) ? null : label;
  }

  function neutralFallback(kind) {
    return FALLBACKS[kind] || 'Detail';
  }

  function translate(field, ownerLabels) {
    var labels = objectOrEmpty(ownerLabels);
    var inline = cleanLabel(field && field.label);
    if (inline) return inline;
    var key = field && field.key;
    if (key !== null && key !== undefined) {
      var mapped = cleanLabel(labels[key]);
      if (mapped) return mapped;
    }
    return neutralFallback(readString(field && field.kind, 'field'));
  }

  function humanizeState(value) {
    var source = readString(value, 'unscheduled').replace(/[-_]+/g, ' ');
    return source.replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function statusView(rawState) {
    var key = readString(rawState, 'unscheduled');
    var override = objectOrEmpty(STATUS_OVERRIDES[key]);
    return {
      label: readString(override.label, humanizeState(key)),
      tone: readString(override.tone, 'neutral'),
      isTerminal: override.isTerminal === true,
      isError: override.isError === true
    };
  }

  function resolveStateKey(item) {
    var fields = objectOrEmpty(item && item.fields);
    return cleanKey(fields.status) || cleanKey(item && item.due_state) || 'unscheduled';
  }

  function toneFrom(value) {
    var tone = cleanKey(value);
    return tone === 'info' || tone === 'success' || tone === 'warning' || tone === 'error' || tone === 'neutral'
      ? tone
      : 'warning';
  }

  function formatWhen(when, options) {
    var startIso = readString(when && when.startIso);
    if (!startIso) return { hasTime: false, dayLabel: '', timeLabel: '' };
    var date = new Date(startIso);
    if (isNaN(date.getTime())) return { hasTime: false, dayLabel: '', timeLabel: '' };
    var locale = options && options.locale;
    var timezone = readString(when && when.timezone);
    return {
      hasTime: true,
      dayLabel: safeFormat(date, { weekday: 'short', month: 'short', day: 'numeric' }, locale, timezone),
      timeLabel: safeFormat(date, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, locale, timezone)
    };
  }

  function safeFormat(date, base, locale, timezone) {
    if (timezone) {
      try {
        return new Intl.DateTimeFormat(locale, Object.assign({}, base, { timeZone: timezone })).format(date);
      } catch (error) {
        // Fall through to local-zone formatting.
      }
    }
    try {
      return new Intl.DateTimeFormat(locale, base).format(date);
    } catch (error) {
      return '';
    }
  }

  function buildTargets(item, ownerLabels) {
    var relationships = arrayOrEmpty(item && item.relationships);
    var out = [];
    for (var i = 0; i < relationships.length; i += 1) {
      var rel = objectOrEmpty(relationships[i]);
      if (rel.relation_role !== 'target') continue;
      var id = cleanKey(rel.target_id);
      if (!id) continue;
      out.push({ id: id, label: translate({ kind: 'target', key: id }, ownerLabels) });
    }
    return out;
  }

  function buildBlockers(item, ownerLabels) {
    var evidence = arrayOrEmpty(item && item.owner_evidence);
    var out = [];
    for (var i = 0; i < evidence.length; i += 1) {
      var row = objectOrEmpty(evidence[i]);
      if (row.allowed !== false) continue;
      var reasonRefs = arrayOrEmpty(row.reason_refs);
      var reasonKey = cleanKey(reasonRefs[0]);
      out.push({
        id: reasonKey || readString(item && item.record_id, 'record') + ':blocker:' + String(out.length),
        label: translate({ kind: 'blocker', key: reasonKey || undefined }, ownerLabels),
        tone: toneFrom(row.tone)
      });
    }
    return out;
  }

  function buildActions(item, ownerLabels) {
    var actions = arrayOrEmpty(item && item.actions);
    var out = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = objectOrEmpty(actions[i]);
      var id = cleanKey(action.action_id);
      if (!id) continue;
      out.push({
        id: id,
        label: translate({ kind: 'action', label: action.label, key: id }, ownerLabels),
        dispatch: action.dispatch && cleanKey(action.dispatch.name)
          ? { name: cleanKey(action.dispatch.name), input: action.dispatch.input == null ? null : action.dispatch.input }
          : null
      });
    }
    return out;
  }

  function buildWhen(item) {
    var timeWindow = objectOrEmpty(item && item.time_window);
    var start = cleanKey(timeWindow.start);
    return {
      dayKey: start && start.length >= 10 ? start.slice(0, 10) : null,
      startIso: start,
      timezone: cleanKey(timeWindow.timezone)
    };
  }

  function buildSchedulerItem(item, ownerLabels, options) {
    var state = statusView(resolveStateKey(item));
    var when = buildWhen(item);
    return {
      id: readString(item.record_id),
      title: translate({ kind: 'post', label: item.label, key: item.record_id }, ownerLabels),
      group: translate({ kind: 'group', label: cleanKey(item.group) || undefined }, ownerLabels),
      status: state,
      when: when,
      formattedWhen: formatWhen(when, options),
      targets: buildTargets(item, ownerLabels),
      blockers: buildBlockers(item, ownerLabels),
      actions: buildActions(item, ownerLabels),
      hasBlockers: buildBlockers(item, ownerLabels).length > 0
    };
  }

  function buildGroups(items) {
    var order = [];
    var byTitle = {};
    for (var i = 0; i < items.length; i += 1) {
      var title = items[i].group;
      if (!byTitle[title]) {
        byTitle[title] = [];
        order.push(title);
      }
      byTitle[title].push(items[i].id);
    }
    return order.map(function (title) {
      return { id: title, title: title, itemIds: byTitle[title] };
    });
  }

  function buildSchedulerModel(projection, options) {
    if (projection === null || projection === undefined) {
      return modelEnvelope('loading', 'default', [], [], COPY.loading.title, []);
    }
    if (!projection || typeof projection !== 'object' || !Array.isArray(projection.items)) {
      return modelEnvelope('error', 'default', [], [], COPY.error.title, []);
    }
    var ownerLabels = objectOrEmpty(options && options.ownerLabels);
    var rawItems = arrayOrEmpty(projection.items);
    var items = [];
    var observed = {};
    for (var i = 0; i < rawItems.length; i += 1) {
      var row = objectOrEmpty(rawItems[i]);
      if (!readString(row.record_id)) continue;
      var stateKey = resolveStateKey(row);
      observed[stateKey] = true;
      items.push(buildSchedulerItem(row, ownerLabels, options || {}));
    }
    var groups = buildGroups(items);
    return modelEnvelope(
      'ready',
      readString(projection.projection_id, 'default'),
      items,
      groups,
      items.length === 0 ? COPY.empty.title : '',
      Object.keys(observed)
    );
  }

  function modelEnvelope(status, projectionId, items, groups, message, observedStateKeys) {
    var visibleActionCount = 0;
    var blockerCount = 0;
    var targetCount = 0;
    var scheduledCount = 0;
    for (var i = 0; i < items.length; i += 1) {
      visibleActionCount += items[i].actions.length;
      blockerCount += items[i].blockers.length;
      targetCount += items[i].targets.length;
      scheduledCount += items[i].when.startIso ? 1 : 0;
    }
    return {
      status: status,
      projectionId: projectionId,
      copy: COPY,
      items: items,
      groups: groups,
      message: message,
      proof: {
        status: status,
        group_count: groups.length,
        item_count: items.length,
        visible_action_count: visibleActionCount,
        blocker_count: blockerCount,
        target_count: targetCount,
        scheduled_count: scheduledCount,
        observed_state_keys: observedStateKeys,
        translation_boundary: 'statusView+translate'
      }
    };
  }

  function selectedItem(model, selectedRecordId) {
    var selected = readString(selectedRecordId);
    for (var i = 0; i < model.items.length; i += 1) {
      if (model.items[i].id === selected) return model.items[i];
    }
    return model.items[0] || null;
  }

  function queueItemsForGroup(model, group) {
    var byId = {};
    for (var i = 0; i < model.items.length; i += 1) byId[model.items[i].id] = model.items[i];
    return arrayOrEmpty(group.itemIds).map(function (id) { return byId[id]; }).filter(Boolean).map(queueItem);
  }

  function queueItem(item) {
    return {
      record_id: item.id,
      title: item.title,
      group: item.group,
      status: item.status,
      time: item.formattedWhen,
      targets: item.targets,
      blockers: item.blockers,
      action_ids: item.actions.map(function (action) { return action.id; }),
      has_blockers: item.hasBlockers
    };
  }

  function detailFor(item) {
    if (!item) return null;
    return {
      record_id: item.id,
      title: item.title,
      group: item.group,
      status: item.status,
      time: item.formattedWhen,
      targets: item.targets,
      blockers: item.blockers,
      actions: item.actions.map(function (action) {
        return {
          action_descriptor_id: action.id,
          label: action.label,
          dispatch: action.dispatch
        };
      }),
      tabs: [
        { id: 'preview', label: 'Preview' },
        { id: 'readiness', label: 'Readiness' },
        { id: 'results', label: 'Results' }
      ]
    };
  }

  function buildTimedActionJscoreModel(projection, options) {
    var opts = objectOrEmpty(options);
    var model = buildSchedulerModel(projection, opts);
    var selected = selectedItem(model, opts.selectedRecordId || opts.selected_record_id);
    var queue = model.groups.map(function (group) {
      return {
        group_id: group.id,
        title: group.title,
        items: queueItemsForGroup(model, group)
      };
    });
    var detail = detailFor(selected);
    return {
      kind: 'timed-action-jscore-model',
      schema: 'timed-action.jscore.v1',
      status: model.status,
      projection_id: model.projectionId,
      selected_record_id: selected ? selected.id : null,
      message: model.message,
      copy: model.copy,
      modes: [
        { id: 'queue', label: model.copy.modes.queue },
        { id: 'calendar', label: model.copy.modes.calendar }
      ],
      queue: queue,
      detail: detail,
      mobile: {
        primary_mode: 'queue',
        sticky_action: detail && detail.actions.length ? detail.actions[0] : null,
        sections: queue.map(function (section) {
          return { id: section.group_id, title: section.title, item_count: section.items.length };
        })
      },
      proof: {
        projection_record_count: typeof projection === 'object' && projection && projection.proof
          ? objectOrEmpty(projection.proof).record_count || model.proof.item_count
          : model.proof.item_count,
        source_addresses: typeof projection === 'object' && projection && projection.proof
          ? arrayOrEmpty(objectOrEmpty(projection.proof).source_addresses)
          : [],
        section_count: queue.length,
        item_count: model.proof.item_count,
        visible_action_count: model.proof.visible_action_count,
        blocker_count: model.proof.blocker_count,
        translation_boundary: model.proof.translation_boundary,
        observed_state_keys: model.proof.observed_state_keys
      }
    };
  }

  function findAction(model, actionDescriptorId) {
    var detail = objectOrEmpty(model && model.detail);
    var actions = arrayOrEmpty(detail.actions);
    var wanted = readString(actionDescriptorId);
    for (var i = 0; i < actions.length; i += 1) {
      if (actions[i].action_descriptor_id === wanted) return actions[i];
    }
    return wanted ? { action_descriptor_id: wanted, dispatch: null } : null;
  }

  function buildTimedActionJscoreInvocation(model, actionDescriptorId, options) {
    var opts = objectOrEmpty(options);
    var action = findAction(model, actionDescriptorId);
    var recordId = readString(opts.recordId || opts.record_id, readString(model && model.selected_record_id));
    var projectionId = readString(model && model.projection_id, 'default');
    var dispatch = action && action.dispatch ? action.dispatch : null;
    var requestable = !!(dispatch && readString(dispatch.name));
    return {
      target: dispatch ? readString(dispatch.name) : '',
      operation: DEFAULT_OPERATION,
      input: Object.assign({
        dispatch_input: dispatch && dispatch.input != null ? dispatch.input : null,
        action_descriptor_id: action ? readString(action.action_descriptor_id) : readString(actionDescriptorId),
        record_id: recordId || null,
        projection_id: projectionId
      }, objectOrEmpty(opts.values)),
      correlationId: readString(opts.correlationId || opts.correlation_id, readString(actionDescriptorId) + ':' + recordId),
      disabledReason: requestable ? undefined : 'This action is not available right now.'
    };
  }

  function node(kind, props, children, id) {
    var built = { kind: kind, props: objectOrEmpty(props), children: arrayOrEmpty(children).filter(Boolean) };
    if (id) built.id = id;
    return built;
  }

  function text(value, size, weight, color, lineLimit) {
    var props = { text: readString(value), size: size, weight: weight || 'regular', color: color || 'darkTextPrimary' };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function stack(axis, spacing, children, props) {
    return node('stack', Object.assign({ axis: axis || 'vertical', spacing: spacing || 0 }, objectOrEmpty(props)), children);
  }

  function box(children, props, id) {
    return node('box', Object.assign({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 12,
      spacing: 8
    }, objectOrEmpty(props)), children, id);
  }

  function badge(label, tone) {
    var color = tone === 'success' ? '#6fdc99' : tone === 'error' ? '#ff8f8f' : tone === 'warning' ? '#ffd27a' : tone === 'info' ? '#8fc7ff' : 'darkTextSecondary';
    var border = tone === 'success' ? '#2aa15f' : tone === 'error' ? '#cc4b4b' : tone === 'warning' ? '#b8871f' : tone === 'info' ? '#3b82f6' : 'darkBorder';
    return box([text(label, 11, 'semibold', color, 1)], {
      background: 'darkSurface',
      border: border,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    });
  }

  function actionButton(model, action, primary) {
    var invocation = buildTimedActionJscoreInvocation(model, action.action_descriptor_id);
    return box([text(action.label, 12, 'semibold', primary ? 'accent' : 'darkTextPrimary', 1)], {
      background: primary ? '#12315a' : 'darkSurfaceRaised',
      border: primary ? 'accent' : 'darkBorder',
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      press: { operation: TARGET_INVOKE_OPERATION, payload: invocation }
    });
  }

  function queueCard(model, item, selected) {
    var children = [
      stack('horizontal', 7, [badge(item.status.label, item.status.tone)].concat(item.targets.map(function (target) {
        return badge(target.label, 'neutral');
      })), { horizontalScroll: true }),
      text(item.title, 16, 'bold', 'darkTextPrimary', 2)
    ];
    if (item.time && item.time.hasTime) {
      children.push(text(item.time.dayLabel + ' · ' + item.time.timeLabel, 12, 'regular', 'darkTextSecondary', 1));
    }
    for (var i = 0; i < item.blockers.length; i += 1) children.push(badge(item.blockers[i].label, item.blockers[i].tone));
    return box(children, { background: selected ? '#132238' : 'darkSurfaceRaised', border: selected ? 'accent' : 'darkBorder' });
  }

  function detailPanel(model) {
    var detail = objectOrEmpty(model.detail);
    if (!detail.record_id) return box([text(model.message || model.copy.empty.title, 18, 'semibold', 'darkTextPrimary', 2)], { background: 'darkSurface' });
    var actionNodes = [];
    for (var i = 0; i < detail.actions.length; i += 1) actionNodes.push(actionButton(model, detail.actions[i], i === 0));
    return box([
      text(detail.title, 21, 'bold', 'darkTextPrimary', 2),
      stack('horizontal', 7, [badge(detail.status.label, detail.status.tone)].concat(detail.targets.map(function (target) {
        return badge(target.label, 'neutral');
      })), { horizontalScroll: true }),
      detail.time && detail.time.hasTime ? text(detail.time.dayLabel + ' · ' + detail.time.timeLabel, 12, 'regular', 'darkTextSecondary', 1) : null,
      detail.blockers.length ? stack('vertical', 7, detail.blockers.map(function (blocker) {
        return badge(blocker.label, blocker.tone);
      })) : null,
      actionNodes.length ? stack('horizontal', 7, actionNodes, { horizontalScroll: true }) : null,
      stack('horizontal', 7, detail.tabs.map(function (tab) { return badge(tab.label, 'neutral'); }), { horizontalScroll: true })
    ], { background: 'darkSurface' });
  }

  function buildSnapshot(model, lifecycleKey) {
    var queueNodes = [];
    for (var i = 0; i < model.queue.length; i += 1) {
      var section = model.queue[i];
      var cards = section.items.map(function (item) {
        return queueCard(model, item, item.record_id === model.selected_record_id);
      });
      queueNodes.push(box([text(section.title, 14, 'bold', 'darkTextPrimary', 1)].concat(cards), { background: 'darkSurface' }));
    }
    var body;
    if (model.status === 'loading') {
      body = box([text(model.copy.loading.title, 18, 'semibold', 'darkTextPrimary', 2), text(model.copy.loading.body, 12, 'regular', 'darkTextSecondary', 3)], { background: 'darkSurface' });
    } else if (model.status === 'error') {
      body = box([text(model.copy.error.title, 18, 'semibold', 'darkTextPrimary', 2), text(model.copy.error.body, 12, 'regular', 'darkTextSecondary', 3)], { background: 'darkSurface' });
    } else if (!model.proof.item_count) {
      body = box([text(model.copy.empty.title, 18, 'semibold', 'darkTextPrimary', 2), text(model.copy.empty.body, 12, 'regular', 'darkTextSecondary', 3)], { background: 'darkSurface' });
    } else {
      body = stack('vertical', 12, queueNodes.concat([detailPanel(model)]));
    }
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: lifecycleKey || DEFAULT_LIFECYCLE_KEY,
      summary: {
        projection_id: model.projection_id,
        selected_record_id: model.selected_record_id,
        item_count: model.proof.item_count,
        section_count: model.proof.section_count,
        translation_boundary: model.proof.translation_boundary
      },
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 18,
        spacing: 14
      }, [
        stack('horizontal', 8, [badge(model.copy.modes.queue, 'info'), badge(String(model.proof.item_count), 'neutral')]),
        text('Timed Action', 28, 'bold', 'darkTextPrimary', 2),
        body
      ])
    };
  }

  function readPackageInput(mount) {
    if (!mount || typeof mount.invoke !== 'function') return null;
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: INPUT_NAME
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found !== false ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function lifecycleKey(record) {
    var source = objectOrEmpty(record);
    var props = objectOrEmpty(source.props);
    return readString(source.lifecycle_key || props.lifecycle_key, DEFAULT_LIFECYCLE_KEY);
  }

  function mountSurface(record, mount) {
    var props = objectOrEmpty(record && record.props);
    var projection = props.projection || props.input || readPackageInput(mount);
    var model = buildTimedActionJscoreModel(projection, {
      selectedRecordId: props.selectedRecordId || props.selected_record_id,
      ownerLabels: props.ownerLabels || props.owner_labels,
      locale: props.locale
    });
    var key = lifecycleKey(record);
    if (mount && typeof mount.invoke === 'function') {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(model, key)));
    }
    return {
      dispose: function dispose() {
        if (mount && typeof mount.invoke === 'function') {
          mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
        }
      }
    };
  }

  var api = {
    buildTimedActionJscoreModel: buildTimedActionJscoreModel,
    buildTimedActionJscoreInvocation: buildTimedActionJscoreInvocation,
    buildTimedActionNativeSnapshot: buildSnapshot,
    bitfieldMount: mountSurface,
    putThingOnScreen: mountSurface
  };

  globalThis.TimedActionJscoreRenderer = api;
  globalThis.bitfieldMount = mountSurface;
  globalThis.putThingOnScreen = mountSurface;
}());
