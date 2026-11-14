// Purpose: JavaScriptCore realization entry for the notifications setting surface.
// It reads package records and the current value through the native bridge,
// runs the same descriptor-shaped projection/write contract as the browser
// surface, and emits sealed native view snapshots. No React, DOM, provider
// sender, or mobile-only backend lives here.

(function () {
  var PACKAGE_NAME = 'notifications';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var MOUNT_ACTION_OPERATION = 'screen.mount.action';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var RECORDS_INPUT = 'published-records';
  var DESCRIPTOR_INPUT = 'setting-control';

  var SHARED_CONTRACT_SOURCE_PATHS = [
    'read-data/read-notifications-policy.ts',
    'read-data/project-setting-view.ts',
    'read-data/setting-copy-table.ts',
    'do-work/save-setting.ts',
    'show/blind-setting-renderer.tsx'
  ];

  var ACCEPTED = { ok: true, success: true, completed: true, accepted: true };

  var SAVE_LABEL = 'Save';
  var REVERT_LABEL = 'Revert';
  var SAVE_DISABLED_NO_CHANGE = 'Choose a different option to save.';
  var SAVE_DISABLED_OFFLINE = 'Reconnect to save your change.';
  var SAVE_DISABLED_SAVING = 'Saving your previous change\u2026';
  var COPY = {
    loading: { statusCopy: 'Loading your current choice\u2026', tone: 'idle' },
    'default': { statusCopy: 'Active now', tone: 'success' },
    ready: { statusCopy: 'Active now', tone: 'success' },
    dirty: { statusCopy: 'Unsaved change', tone: 'warning' },
    saving: { statusCopy: 'Saving\u2026', tone: 'info' },
    saved: { statusCopy: 'Saved', tone: 'success' },
    error: { statusCopy: 'That change did not save. Your choice is unchanged.', tone: 'error' },
    invalid: { statusCopy: 'Your saved choice is no longer offered. Pick one below.', tone: 'warning' },
    offline: { statusCopy: 'You are offline. Changes cannot be saved right now.', tone: 'warning' }
  };

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function objectOrEmpty(value) {
    return isRecord(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function cloneJson(value) {
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i += 1) arr.push(cloneJson(value[i]));
      return arr;
    }
    if (isRecord(value)) {
      var out = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = cloneJson(value[key]);
      }
      return out;
    }
    return value;
  }

  function textOf(value, fallback) {
    return typeof value === 'string' && value.length > 0 ? value : (fallback || '');
  }

  function textList(value) {
    var out = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') out.push(value[i]);
    }
    return out;
  }

  function firstPresent(a, b, c) {
    if (a !== undefined && a !== null) return a;
    if (b !== undefined && b !== null) return b;
    return c;
  }

  function coerceRecords(value) {
    var source = value;
    if (isRecord(source) && Array.isArray(source.records)) source = source.records;
    if (isRecord(source) && Array.isArray(source.things)) source = source.things;
    var rows = arrayOrEmpty(source);
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = objectOrEmpty(rows[i]);
      out.push({
        address: textOf(row.address),
        payload: row.payload
      });
    }
    return out;
  }

  function settingDescriptors(records) {
    var out = [];
    for (var i = 0; i < records.length; i += 1) {
      var row = records[i];
      if (typeof row.address === 'string' && isRecord(row.payload) && row.payload.kind === 'setting-control') {
        out.push({ address: row.address, payload: row.payload });
      }
    }
    return out;
  }

  function optionId(option, index) {
    return textOf(firstPresent(firstPresent(option.id, option.value), option.key), 'option:' + String(index));
  }

  function descriptorValue(descriptor) {
    return isRecord(descriptor.value) ? descriptor.value : {};
  }

  function nestedValue(value, valueKeys) {
    var candidates = ['id'];
    for (var i = 0; i < valueKeys.length; i += 1) candidates.push(valueKeys[i]);
    for (var c = 0; c < candidates.length; c += 1) {
      var found = textOf(value[candidates[c]]);
      if (found) return found;
    }
    return '';
  }

  function currentValueFromRows(rows, propertyIds, valueKeys) {
    var list = arrayOrEmpty(rows);
    for (var i = 0; i < list.length; i += 1) {
      var row = objectOrEmpty(list[i]);
      var propertyId = textOf(firstPresent(row.property_id, row.propertyId));
      if (propertyIds.length > 0 && propertyIds.indexOf(propertyId) === -1) continue;
      var value = row.value;
      if (typeof value === 'string' && value.length > 0) return value;
      if (isRecord(value)) {
        var nested = nestedValue(value, valueKeys);
        if (nested) return nested;
      }
    }
    return null;
  }

  function resolveCurrentOptionId(descriptor, currentRecords) {
    var value = descriptorValue(descriptor);
    var propertyIds = textList(firstPresent(value.property_ids, value.propertyIds));
    var valueKeys = textList(value.keys);
    var fromRows = currentValueFromRows(currentRecords || [], propertyIds, valueKeys);
    if (fromRows !== null) return fromRows;
    return textOf(value['default'], '') || null;
  }

  function optionViews(descriptor, selectedOptionId, currentOptionId) {
    var rawOptions = Array.isArray(descriptor.options) ? descriptor.options : [];
    var out = [];
    for (var i = 0; i < rawOptions.length; i += 1) {
      var option = rawOptions[i];
      if (!isRecord(option)) continue;
      var id = optionId(option, i);
      out.push({
        id: id,
        label: textOf(option.label, id),
        description: textOf(option.description),
        iconName: textOf(option.icon),
        selected: selectedOptionId === id,
        isCurrent: currentOptionId === id
      });
    }
    return out;
  }

  function statusCopy(status) {
    if (status === 'empty') return 'No choices are described yet.';
    if (status === 'dirty') return 'Unsaved choice.';
    if (status === 'invalid') return 'The saved choice is not described by this setting.';
    return 'Current choice is saved.';
  }

  function graphRoute(records, descriptorAddress) {
    var graph = null;
    for (var i = 0; i < records.length; i += 1) {
      var payload = records[i].payload;
      if (!isRecord(payload) || payload.kind !== 'record-policy-action-graph' || !Array.isArray(payload.records)) continue;
      for (var r = 0; r < payload.records.length; r += 1) {
        var entry = payload.records[r];
        if (isRecord(entry) && entry.address === descriptorAddress) graph = payload;
      }
    }
    var routes = graph && Array.isArray(graph.action_routes) ? graph.action_routes : [];
    var route = null;
    for (var j = 0; j < routes.length; j += 1) {
      if (isRecord(routes[j])) {
        route = routes[j];
        break;
      }
    }
    if (!route) return null;
    var bindings = isRecord(route.bindings) ? route.bindings : {};
    var operation = textOf(firstPresent(route.method, route.operation));
    var definitionId = textOf(firstPresent(firstPresent(bindings.definition_id, route.definition_id), route.definitionId), '');
    var payloadDefaults = isRecord(route.payload_defaults) ? route.payload_defaults : {};
    var payloadTemplate = { operation: operation };
    if (definitionId) payloadTemplate.definition_id = definitionId;
    var clonedDefaults = cloneJson(payloadDefaults);
    for (var key in clonedDefaults) {
      if (Object.prototype.hasOwnProperty.call(clonedDefaults, key)) payloadTemplate[key] = clonedDefaults[key];
    }
    return {
      id: textOf(route.id, 'action-route'),
      target: textOf(route.target),
      valuePath: textList(firstPresent(firstPresent(bindings.value_path, route.value_path), route.valuePath)),
      payloadTemplate: payloadTemplate
    };
  }

  function descriptorRoute(descriptor) {
    var write = isRecord(descriptor.write) ? descriptor.write : null;
    if (!write) return null;
    var payload = isRecord(write.payload) ? write.payload : {};
    return {
      id: textOf(firstPresent(payload.definition_id, descriptor.id), 'setting-write'),
      target: textOf(write.target),
      valuePath: textList(firstPresent(write.value_path, write.valuePath)),
      payloadTemplate: cloneJson(payload)
    };
  }

  function proofRefs(records, descriptorAddress) {
    var out = [];
    for (var i = 0; i < records.length; i += 1) {
      var row = records[i];
      if (typeof row.address !== 'string' || row.address === descriptorAddress || !isRecord(row.payload)) continue;
      var kind = textOf(row.payload.kind);
      if (kind === 'record-policy-action-graph' || kind === 'side-effect-intent-route') out.push(row.address);
    }
    return out;
  }

  function readPolicy(input) {
    var records = coerceRecords(input.records || []);
    var descriptors = settingDescriptors(records);
    var descriptorAddress = descriptors[0] ? descriptors[0].address : '';
    var descriptor = isRecord(input.descriptor) ? input.descriptor : (descriptors[0] ? descriptors[0].payload : {});
    var heading = textOf(firstPresent(descriptor.title, descriptor.label), textOf(descriptor.id, 'Setting'));
    var explanation = textOf(descriptor.description);
    var currentOptionId = resolveCurrentOptionId(descriptor, input.currentRecords || []);
    var selectedOptionId = input.selectedOptionId !== undefined && input.selectedOptionId !== null
      ? input.selectedOptionId
      : currentOptionId;
    var options = optionViews(descriptor, selectedOptionId, currentOptionId);
    var hasOptions = options.length > 0;
    var currentIsDeclared = currentOptionId === null;
    var selectedIsDeclared = selectedOptionId === null;
    for (var i = 0; i < options.length; i += 1) {
      if (options[i].id === currentOptionId) currentIsDeclared = true;
      if (options[i].id === selectedOptionId) selectedIsDeclared = true;
    }
    var dirty = currentOptionId !== selectedOptionId;
    var status = !hasOptions ? 'empty' : (!currentIsDeclared || !selectedIsDeclared ? 'invalid' : (dirty ? 'dirty' : 'ready'));
    return {
      descriptorAddress: descriptorAddress,
      heading: heading,
      explanation: explanation,
      options: options,
      currentOptionId: currentOptionId,
      selectedOptionId: selectedOptionId,
      status: status,
      statusCopy: statusCopy(status),
      errorCopy: status === 'invalid' ? statusCopy(status) : null,
      save: {
        label: SAVE_LABEL,
        enabled: status === 'dirty',
        disabledReason: status === 'dirty' ? null : statusCopy(status)
      },
      revert: {
        label: REVERT_LABEL,
        enabled: dirty && currentIsDeclared
      },
      actionRoute: graphRoute(records, descriptorAddress) || descriptorRoute(descriptor),
      proofRefs: proofRefs(records, descriptorAddress)
    };
  }

  function settingCopy(status) {
    return COPY[status];
  }

  function presentationStatus(policy, phase, offline) {
    if (offline) return 'offline';
    if (phase === 'loading') return 'loading';
    if (phase === 'saving') return 'saving';
    if (phase === 'error') return 'error';
    if (policy.status === 'invalid') return 'invalid';
    if (policy.status === 'dirty') return 'dirty';
    if (policy.status === 'empty') return 'loading';
    return phase === 'saved' ? 'saved' : 'ready';
  }

  function saveDisabledReason(status, policyEnabled) {
    if (status === 'offline') return SAVE_DISABLED_OFFLINE;
    if (status === 'saving') return SAVE_DISABLED_SAVING;
    if (policyEnabled) return null;
    return SAVE_DISABLED_NO_CHANGE;
  }

  function projectView(input) {
    var policy = input.policy;
    var phase = input.phase || 'idle';
    var offline = input.offline === true;
    var status = presentationStatus(policy, phase, offline);
    var copy = settingCopy(status);
    var currentOption = null;
    for (var i = 0; i < policy.options.length; i += 1) {
      if (policy.options[i].isCurrent) currentOption = policy.options[i];
    }
    var saveEnabled = policy.save.enabled && status !== 'saving' && status !== 'offline';
    var revertEnabled = policy.revert.enabled && status !== 'saving';
    var options = [];
    for (var j = 0; j < policy.options.length; j += 1) {
      var option = policy.options[j];
      options.push({
        id: option.id,
        label: option.label,
        description: option.description,
        iconName: option.iconName,
        selected: option.selected,
        isCurrent: option.isCurrent
      });
    }
    return {
      heading: policy.heading,
      explanation: policy.explanation,
      options: options,
      status: status,
      statusTone: copy.tone,
      statusCopy: copy.statusCopy,
      errorCopy: status === 'error'
        ? (input.errorMessage || copy.statusCopy)
        : (status === 'invalid' ? copy.statusCopy : null),
      currentLabel: currentOption ? currentOption.label : null,
      save: {
        label: SAVE_LABEL,
        enabled: saveEnabled,
        disabledReason: saveEnabled ? null : saveDisabledReason(status, policy.save.enabled)
      },
      revert: {
        label: REVERT_LABEL,
        enabled: revertEnabled
      }
    };
  }

  function insertValueAtPath(template, valuePath, value) {
    if (valuePath.length === 0) return value;
    var payload = cloneJson(template);
    if (!isRecord(payload)) {
      throw new Error('Setting write payload template must be an object when a value path is set');
    }
    var cursor = payload;
    for (var i = 0; i < valuePath.length - 1; i += 1) {
      var segment = valuePath[i];
      var next = cursor[segment];
      if (isRecord(next)) {
        cursor = next;
      } else {
        var created = {};
        cursor[segment] = created;
        cursor = created;
      }
    }
    cursor[valuePath[valuePath.length - 1]] = value;
    return payload;
  }

  function buildActionPayload(route, optionId) {
    return insertValueAtPath(route.payloadTemplate, route.valuePath, optionId);
  }

  function interpretReply(reply) {
    if (!isRecord(reply)) return { ok: true };
    if (reply.offline === true) return { ok: false, offline: true };
    var status = typeof reply.status === 'string' ? reply.status.toLowerCase() : '';
    if (status.length > 0) return { ok: ACCEPTED[status] === true };
    if (reply.ok === false || (reply.error !== undefined && reply.error !== null)) return { ok: false };
    return { ok: true };
  }

  function phaseFromOutcome(outcome) {
    return outcome.ok ? 'saved' : 'error';
  }

  function node(kind, props, children, id) {
    var built = {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean)
    };
    if (id) built.id = id;
    return built;
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value === undefined || value === null ? '' : value),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function box(props, children, id) {
    return node('box', props, children, id);
  }

  function stack(axis, spacing, children, props) {
    var merged = objectOrEmpty(props);
    merged.axis = axis;
    merged.spacing = spacing;
    return node('stack', merged, children);
  }

  function mountAction(type, payload) {
    return { operation: MOUNT_ACTION_OPERATION, payload: { type: type, payload: payload || {} } };
  }

  function toneColor(tone) {
    if (tone === 'success') return '#6fdc99';
    if (tone === 'error') return '#ff8f8f';
    if (tone === 'accent') return '#7aa2ff';
    if (tone === 'info') return '#7ad0ff';
    if (tone === 'warning') return '#ffce6f';
    return 'darkTextSecondary';
  }

  function statusBadgeFor(view) {
    return stack('horizontal', 8, [
      box({ background: toneColor(view.statusTone), cornerRadius: 999, padding: 5, fillWidth: false }, []),
      text(view.statusCopy, 12, 'regular', 'darkTextSecondary', 3)
    ], { alignItems: 'center' });
  }

  function optionCard(option, busy) {
    var trailing = option.isCurrent
      ? text(COPY.ready.statusCopy, 11, 'semibold', '#6fdc99', 1)
      : option.selected
        ? text('Selected', 11, 'semibold', '#7aa2ff', 1)
        : null;
    return box({
      background: option.selected ? '#132238' : 'darkSurface',
      border: option.isCurrent ? 'accent' : (option.selected ? 'accent' : 'darkBorder'),
      borderWidth: 1,
      cornerRadius: 16,
      padding: 12,
      spacing: 8,
      press: busy ? null : mountAction('select', { id: option.id }),
      role: 'radio',
      selected: option.selected === true
    }, [
      stack('horizontal', 10, [
        stack('vertical', 2, [
          text(option.label, 16, 'bold', 'darkTextPrimary', 1),
          option.description ? text(option.description, 12, 'regular', 'darkTextSecondary', 2) : null
        ], { fillWidth: true }),
        trailing
      ], { alignItems: 'center' })
    ]);
  }

  function settingButton(label, action, primary, enabled) {
    return box({
      background: !enabled ? 'darkSurface' : (primary ? '#12315a' : 'darkSurfaceRaised'),
      border: !enabled ? 'darkBorder' : (primary ? 'accent' : 'darkBorder'),
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      opacity: enabled ? 1 : 0.5,
      press: enabled ? action : null
    }, [text(label, 12, 'semibold', !enabled ? 'darkTextSecondary' : (primary ? 'accent' : 'darkTextPrimary'), 1)]);
  }

  function saveBar(view, busy) {
    var children = [settingButton(view.save.label, mountAction('save', {}), true, view.save.enabled && !busy)];
    if (view.revert.enabled) children.push(settingButton(view.revert.label, mountAction('revert', {}), false, !busy));
    var bar = [stack('horizontal', 8, children)];
    if (!view.save.enabled && view.save.disabledReason) bar.push(text(view.save.disabledReason, 11, 'regular', 'darkTextSecondary', 2));
    return stack('vertical', 6, bar);
  }

  function errorCard(view, canRetry) {
    var children = [text(view.errorCopy, 13, 'semibold', '#ff8f8f', 4)];
    if (canRetry) children.push(settingButton('Try again', mountAction('save', {}), false, true));
    return box({
      background: '#3a1717',
      border: '#cc4b4b',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 12,
      spacing: 8
    }, children);
  }

  function buildSnapshot(view, key) {
    var children;
    if (view.status === 'loading') {
      children = [
        box({
          background: 'darkSurface',
          border: 'darkBorder',
          borderWidth: 1,
          cornerRadius: 18,
          padding: 16,
          spacing: 8
        }, [text(view.statusCopy, 14, 'regular', 'darkTextSecondary', 3)])
      ];
    } else {
      var busy = view.status === 'saving';
      var optionNodes = [];
      for (var i = 0; i < view.options.length; i += 1) optionNodes.push(optionCard(view.options[i], busy));
      children = [
        stack('vertical', 4, [
          text(view.heading, 30, 'bold', 'darkTextPrimary', 2),
          view.explanation ? text(view.explanation, 13, 'regular', 'darkTextSecondary', 3) : null
        ]),
        stack('vertical', 8, optionNodes, { role: 'radiogroup' }),
        view.errorCopy !== null ? errorCard(view, view.status === 'error') : statusBadgeFor(view),
        saveBar(view, busy)
      ];
    }
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 14
      }, children)
    };
  }

  function failureSnapshot(key, error) {
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 12
      }, [
        text('This setting could not open', 24, 'bold', 'darkTextPrimary', 2),
        text(String(error && error.message ? error.message : error), 13, 'regular', '#ff8f8f', 6)
      ])
    };
  }

  function lifecycleKey(record) {
    return textOf(objectOrEmpty(record).lifecycle_key, 'component:notifications:jscore');
  }

  function readPackageInput(mount, inputName) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: inputName
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found !== false ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function surfaceRecords(record, mount) {
    var source = objectOrEmpty(record);
    var surfaceInput = objectOrEmpty(source.surfaceInput || source.surface_input);
    var localRecords = coerceRecords(surfaceInput.records || source.records);
    if (localRecords.length > 0) return localRecords;
    return coerceRecords(readPackageInput(mount, RECORDS_INPUT));
  }

  function surfaceDescriptor(record, records, mount) {
    var source = objectOrEmpty(record);
    var surfaceInput = objectOrEmpty(source.surfaceInput || source.surface_input);
    if (isRecord(surfaceInput.descriptor)) return surfaceInput.descriptor;
    if (isRecord(source.descriptor)) return source.descriptor;
    var descriptors = settingDescriptors(records);
    if (descriptors[0]) return descriptors[0].payload;
    return readPackageInput(mount, DESCRIPTOR_INPUT);
  }

  function currentInputName(descriptor) {
    var value = descriptorValue(objectOrEmpty(descriptor));
    return textOf(firstPresent(value.feed_label, value.feedLabel));
  }

  function mountNotifications(record, mount) {
    var key = lifecycleKey(record);
    var records = [];
    var descriptor = null;
    var currentRecords = [];
    var draftOptionId = null;
    var phase = 'idle';
    var offline = false;
    var errorMessage = null;

    function valueInputRows() {
      var inputName = currentInputName(descriptor);
      return inputName ? arrayOrEmpty(readPackageInput(mount, inputName)) : [];
    }

    function policy() {
      return readPolicy({
        descriptor: descriptor,
        records: records,
        currentRecords: currentRecords,
        selectedOptionId: draftOptionId
      });
    }

    function currentView() {
      return projectView({ policy: policy(), phase: phase, offline: offline, errorMessage: errorMessage });
    }

    function replace() {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(currentView(), key)));
    }

    function commit() {
      var nextPolicy = policy();
      var selected = nextPolicy.selectedOptionId;
      if (!selected || !nextPolicy.save.enabled) return;
      phase = 'saving';
      offline = false;
      errorMessage = null;
      replace();
      if (!nextPolicy.actionRoute || !nextPolicy.actionRoute.target) {
        phase = 'error';
        errorMessage = 'This setting is read-only and cannot be changed here.';
        replace();
        return;
      }
      var replyText = null;
      try {
        var payload = buildActionPayload(nextPolicy.actionRoute, selected);
        replyText = mount.invoke(TARGET_INVOKE_OPERATION, JSON.stringify({
          target: nextPolicy.actionRoute.target,
          payload: payload
        }));
      } catch (error) {
        phase = 'error';
        errorMessage = 'That change did not save. Your choice is unchanged.';
        replace();
        return;
      }
      var reply = null;
      try {
        reply = replyText ? JSON.parse(replyText) : null;
      } catch (error) {
        reply = null;
      }
      var outcome = interpretReply(reply);
      offline = outcome.offline === true;
      phase = phaseFromOutcome(outcome);
      if (phase === 'saved') {
        currentRecords = valueInputRows();
        draftOptionId = null;
      } else {
        errorMessage = 'That change did not save. Your choice is unchanged.';
      }
      replace();
    }

    try {
      records = surfaceRecords(record, mount);
      descriptor = surfaceDescriptor(record, records, mount);
      if (!isRecord(descriptor)) {
        mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(failureSnapshot(key, 'No setting descriptor was delivered.')));
      } else {
        currentRecords = valueInputRows();
        replace();
      }
    } catch (error) {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(failureSnapshot(key, error)));
    }

    globalThis.bitfieldOnAction = function bitfieldOnAction(payloadText) {
      var action = {};
      try {
        action = JSON.parse(payloadText || '{}');
      } catch (error) {
        action = {};
      }
      if (action.type === 'select') {
        draftOptionId = textOf(objectOrEmpty(action.payload).id) || null;
        phase = 'idle';
        offline = false;
        errorMessage = null;
        replace();
      } else if (action.type === 'revert') {
        draftOptionId = null;
        phase = 'idle';
        offline = false;
        errorMessage = null;
        replace();
      } else if (action.type === 'save') {
        commit();
      }
    };

    return {
      dispose: function dispose() {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.NotificationsJscore = {
    sharedContractSourcePaths: SHARED_CONTRACT_SOURCE_PATHS,
    copy: COPY,
    readPolicy: readPolicy,
    projectView: projectView,
    buildActionPayload: buildActionPayload,
    interpretReply: interpretReply,
    buildSnapshot: buildSnapshot
  };
  globalThis.bitfieldMount = mountNotifications;
  globalThis.putThingOnScreen = mountNotifications;
}());
