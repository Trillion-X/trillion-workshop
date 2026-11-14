// Purpose: JavaScriptCore native screen-command mount for request-intake.
// Invariants: no React, DOM, or iOS-only backend. The mount consumes the same
// package-owned screen model as browser surfaces and emits sealed native ops.

(function () {
  var PACKAGE_NAME = 'request-intake';
  var SCREEN_MODEL_INPUT = 'screen-model';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var PACKAGE_CHANGE_TARGET = 'package::request-intake::target::request-intake-change';
  var RENDER_STATES = {
    empty: true,
    sparse: true,
    dense: true,
    loading: true,
    error: true,
    offline: true,
    conflict: true
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

  function readState(value) {
    var text = readString(value, 'loading');
    return RENDER_STATES[text] ? text : 'loading';
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
      text: readString(value),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function stack(axis, spacing, children, props, id) {
    var merged = objectOrEmpty(props);
    merged.axis = axis || 'vertical';
    merged.spacing = spacing || 0;
    return node('stack', merged, children, id);
  }

  function box(children, props, id) {
    return node('box', Object.assign({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 12
    }, objectOrEmpty(props)), children, id);
  }

  function badge(label, tone) {
    var accent = tone === 'accent';
    var warning = tone === 'warning';
    var error = tone === 'error';
    return node('box', {
      background: accent ? '#12315a' : warning ? '#493715' : error ? '#4b1c1c' : 'darkSurface',
      border: accent ? 'accent' : warning ? '#9a6b18' : error ? '#c94a4a' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    }, [text(label, 11, 'semibold', accent ? 'accent' : 'darkTextSecondary', 1)]);
  }

  function statusCopy(status) {
    switch (status) {
      case 'empty':
        return { title: 'Nothing to review yet', detail: 'Create or publish a shape, then submitted records appear here.', tone: 'neutral' };
      case 'sparse':
        return { title: 'Ready to review', detail: 'A small set is ready. Open one record and choose the next action.', tone: 'accent' };
      case 'dense':
        return { title: 'Many records ready', detail: 'Use the configured views and one record at a time.', tone: 'accent' };
      case 'error':
        return { title: 'Could not load this screen', detail: 'Try again. The saved records stay unchanged.', tone: 'error' };
      case 'offline':
        return { title: 'Offline', detail: 'You can inspect saved data. Sending actions waits for connection.', tone: 'warning' };
      case 'conflict':
        return { title: 'One saved change needs review', detail: 'Check the issue before continuing.', tone: 'warning' };
      case 'loading':
      default:
        return { title: 'Loading', detail: 'Preparing the latest saved model.', tone: 'neutral' };
    }
  }

  function normalizeDescriptor(value) {
    var source = objectOrEmpty(value);
    var id = readString(source.id || source.ref || source.descriptor_ref);
    if (!id) return null;
    return {
      id: id,
      label: readString(source.label, id),
      order: typeof source.order === 'number' ? source.order : 0,
      target: readString(source.target),
      operation: readString(source.operation),
      definitionId: readString(source.definitionId || source.definition_id),
      definitionIds: arrayOrEmpty(source.definitionIds || source.definition_ids).filter(function (entry) { return typeof entry === 'string'; }),
      input: objectOrEmpty(source.input),
      copy: arrayOrEmpty(source.copy),
      fields: arrayOrEmpty(source.fields).map(normalizeField).filter(Boolean),
      disabledReason: readString(source.disabledReason || source.disabled_reason)
    };
  }

  function normalizeField(value) {
    var source = objectOrEmpty(value);
    var id = readString(source.id || source.ref || source.field_ref);
    if (!id) return null;
    return {
      id: id,
      label: readString(source.label, id),
      order: typeof source.order === 'number' ? source.order : 0,
      valueKind: readString(source.valueKind || source.value_kind),
      required: source.required === true,
      rules: arrayOrEmpty(source.rules).map(normalizeDescriptor).filter(Boolean)
    };
  }

  function normalizeShape(value) {
    var source = objectOrEmpty(value);
    var id = readString(source.id || source.ref || source.shape_ref);
    if (!id) return null;
    return {
      id: id,
      label: readString(source.label, id),
      versionRef: readString(source.versionRef || source.version_ref),
      fields: arrayOrEmpty(source.fields).map(normalizeField).filter(Boolean),
      actions: arrayOrEmpty(source.actions).map(normalizeDescriptor).filter(Boolean),
      views: arrayOrEmpty(source.views).map(normalizeDescriptor).filter(Boolean),
      sharePolicies: arrayOrEmpty(source.sharePolicies || source.share_policies).map(normalizeDescriptor).filter(Boolean)
    };
  }

  function normalizeValue(value) {
    var source = objectOrEmpty(value);
    var fieldId = readString(source.fieldId || source.field_id);
    if (!fieldId) return null;
    return {
      fieldId: fieldId,
      label: readString(source.label, fieldId),
      value: source.value,
      valueText: readString(source.valueText || source.value_text, 'Not set')
    };
  }

  function normalizeReceipt(value) {
    var source = objectOrEmpty(value);
    var ref = readString(source.ref || source.id || source.receipt_ref);
    if (!ref) return null;
    return {
      ref: ref,
      ownerRef: readString(source.ownerRef || source.owner_ref),
      title: readString(source.title || source.label, ref),
      summary: readString(source.summary),
      time: readString(source.time || source.observedAt || source.observed_at),
      state: readString(source.state || source.status),
      processSessionRef: readString(source.processSessionRef || source.process_session_ref)
    };
  }

  function normalizeRecord(value) {
    var source = objectOrEmpty(value);
    var id = readString(source.id || source.ref || source.instance_ref);
    if (!id) return null;
    return {
      id: id,
      shapeId: readString(source.shapeId || source.shape_id),
      title: readString(source.title || source.label || source.name, id),
      stateId: readString(source.stateId || source.state_id),
      sourceLabel: readString(source.sourceLabel || source.source_label),
      receivedAt: readString(source.receivedAt || source.received_at),
      values: arrayOrEmpty(source.values).map(normalizeValue).filter(Boolean),
      linkedReceiptRefs: arrayOrEmpty(source.linkedReceiptRefs || source.linked_receipt_refs).filter(function (entry) { return typeof entry === 'string'; }),
      actionDescriptorIds: arrayOrEmpty(source.actionDescriptorIds || source.action_descriptor_ids).filter(function (entry) { return typeof entry === 'string'; }),
      linkedReceipts: arrayOrEmpty(source.linkedReceipts || source.linked_receipts).map(normalizeReceipt).filter(Boolean),
      actions: arrayOrEmpty(source.actions).map(normalizeDescriptor).filter(Boolean)
    };
  }

  function normalizeSurface(value) {
    var source = objectOrEmpty(value);
    var shapes = arrayOrEmpty(source.shapes).map(normalizeShape).filter(Boolean);
    var records = arrayOrEmpty(source.records).map(normalizeRecord).filter(Boolean);
    var actions = arrayOrEmpty(source.actions).map(normalizeDescriptor).filter(Boolean);
    var selectedShape = normalizeShape(source.selectedShape || source.selected_shape) || shapes[0] || null;
    var selectedRecord = normalizeRecord(source.selectedRecord || source.selected_record) || records[0] || null;
    return {
      status: readState(source.status),
      shapes: shapes,
      views: arrayOrEmpty(source.views).map(normalizeDescriptor).filter(Boolean),
      states: arrayOrEmpty(source.states).map(normalizeDescriptor).filter(Boolean),
      actions: actions,
      receipts: arrayOrEmpty(source.receipts).map(normalizeReceipt).filter(Boolean),
      records: records,
      selectedShape: selectedShape,
      selectedRecord: selectedRecord,
      issues: arrayOrEmpty(source.issues).map(function (entry) { return readString(entry); }).filter(Boolean)
    };
  }

  function readPackageInput(bridge, inputName) {
    var responseText = bridge.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
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

  function loadSurface(mountRecord, bridge) {
    var record = objectOrEmpty(mountRecord);
    var props = objectOrEmpty(record.props);
    var direct = record.surface || record.screen_model || record.screenModel || props.surface || props.screen_model || props.screenModel;
    if (direct) return normalizeSurface(direct);
    var fromInput = readPackageInput(bridge, SCREEN_MODEL_INPUT);
    if (fromInput) return normalizeSurface(fromInput);
    return normalizeSurface({ status: 'loading' });
  }

  function actionContext(action, surface) {
    var record = surface.selectedRecord || {};
    var shape = surface.selectedShape || {};
    var fieldValues = {};
    var values = arrayOrEmpty(record.values);
    for (var i = 0; i < values.length; i += 1) fieldValues[values[i].fieldId] = values[i].value;
    var descriptors = arrayOrEmpty(record.actions).length ? record.actions : surface.actions;
    return {
      operationId: 'request-intake-ios:' + readString(action.id, 'action') + ':' + readString(record.id, 'record'),
      recordRef: readString(record.id),
      shapeRef: readString(shape.id || record.shapeId),
      descriptorId: readString(action.id),
      fieldValues: fieldValues,
      linkedReceiptRefs: arrayOrEmpty(record.linkedReceiptRefs),
      answers: fieldValues,
      descriptors: descriptors
    };
  }

  function actionPress(action, surface) {
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: PACKAGE_CHANGE_TARGET,
        payload: actionContext(action, surface)
      }
    };
  }

  function actionButton(action, surface) {
    var disabledReason = readString(action.disabledReason);
    return box([
      text(action.label, 13, 'semibold', disabledReason ? 'darkTextSecondary' : 'accent', 1),
      disabledReason ? text(disabledReason, 11, 'regular', 'darkTextSecondary', 2) : null
    ], {
      press: disabledReason ? null : actionPress(action, surface),
      border: disabledReason ? 'darkBorder' : 'accent',
      background: disabledReason ? 'darkSurface' : '#12315a'
    }, 'action:' + action.id);
  }

  function screen(id, title, subtitle, children, stickyAction) {
    return {
      id: id,
      title: title,
      subtitle: subtitle || '',
      stickyAction: stickyAction || null,
      root: stack('vertical', 10, [
        text(title, 18, 'bold', 'darkTextPrimary', 2),
        subtitle ? text(subtitle, 12, 'regular', 'darkTextSecondary', 3) : null,
        stack('vertical', 8, children)
      ], { fillWidth: true }, id + ':root')
    };
  }

  function rootScreen(surface) {
    var copy = statusCopy(surface.status);
    var chips = surface.views.map(function (view) { return badge(view.label, view.selected ? 'accent' : 'neutral'); });
    var rows = surface.records.slice(0, 8).map(function (record) {
      return box([
        text(record.title, 14, 'semibold', 'darkTextPrimary', 1),
        text([record.sourceLabel, record.receivedAt].filter(Boolean).join(' - '), 11, 'regular', 'darkTextSecondary', 1)
      ], { background: 'darkSurface' }, 'record:' + record.id);
    });
    return screen('root', copy.title, copy.detail, [
      badge(surface.status, copy.tone),
      chips.length ? stack('horizontal', 6, chips, { wrap: true }) : null,
      rows.length ? stack('vertical', 6, rows) : text('No records are available from the current model.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function builderScreen(surface) {
    var shape = surface.selectedShape || {};
    var fields = arrayOrEmpty(shape.fields).map(function (field) {
      return box([
        text(field.label, 13, 'semibold', 'darkTextPrimary', 1),
        text([field.required ? 'Required' : '', field.valueKind].filter(Boolean).join(' - '), 11, 'regular', 'darkTextSecondary', 1)
      ], { background: 'darkSurface' }, 'field:' + field.id);
    });
    return screen('builder', readString(shape.label, 'Shape'), 'Review the configured fields one at a time.', fields.length ? fields : [
      text('No fields are configured in the current model.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function settingsScreen(surface) {
    var shape = surface.selectedShape || {};
    var field = arrayOrEmpty(shape.fields)[0] || {};
    var rules = arrayOrEmpty(field.rules).map(function (rule) { return badge(rule.label, 'neutral'); });
    return screen('question-settings', readString(field.label, 'Field settings'), readString(field.valueKind, 'Configured field'), [
      text(field.required ? 'A value is required.' : 'A value is optional.', 12, 'regular', 'darkTextSecondary', 2),
      rules.length ? stack('horizontal', 6, rules, { wrap: true }) : text('No extra rules are configured.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function previewScreen(surface) {
    var shape = surface.selectedShape || {};
    var fields = arrayOrEmpty(shape.fields).map(function (field) { return text(field.label, 12, 'regular', 'darkTextPrimary', 1); });
    return screen('preview', 'Preview', readString(shape.versionRef, 'Current saved version'), fields.length ? fields : [
      text('The current model has no preview fields.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function shareScreen(surface) {
    var shape = surface.selectedShape || {};
    var policies = arrayOrEmpty(shape.sharePolicies).map(function (policy) { return badge(policy.label, 'neutral'); });
    return screen('share', 'Share', 'Review available share settings before sending.', policies.length ? policies : [
      text('No share settings are configured.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function detailScreen(surface) {
    var record = surface.selectedRecord || {};
    var values = arrayOrEmpty(record.values).map(function (value) {
      return box([
        text(value.label, 11, 'regular', 'darkTextSecondary', 1),
        text(value.valueText, 13, 'semibold', 'darkTextPrimary', 2)
      ], { background: 'darkSurface' }, 'value:' + value.fieldId);
    });
    var receipts = arrayOrEmpty(record.linkedReceipts).map(function (receipt) {
      return box([
        text(receipt.title, 12, 'semibold', 'darkTextPrimary', 1),
        receipt.summary ? text(receipt.summary, 11, 'regular', 'darkTextSecondary', 2) : null
      ], { background: 'darkSurface' }, 'receipt:' + receipt.ref);
    });
    return screen('submission-detail', readString(record.title, 'Selected record'), [record.sourceLabel, record.receivedAt].filter(Boolean).join(' - '), [
      values.length ? stack('vertical', 6, values) : text('No values are available.', 12, 'regular', 'darkTextSecondary', 2),
      receipts.length ? stack('vertical', 6, receipts) : text('No owner receipts are linked yet.', 12, 'regular', 'darkTextSecondary', 2)
    ]);
  }

  function followUpScreen(surface) {
    var record = surface.selectedRecord || {};
    var actions = arrayOrEmpty(record.actions).length ? record.actions : surface.actions;
    var actionNodes = actions.map(function (action) { return actionButton(action, surface); });
    return screen('follow-up', 'Next action', 'Choose one configured action and send it through the package target.', actionNodes.length ? actionNodes : [
      text('No actions are configured for the selected record.', 12, 'regular', 'darkTextSecondary', 2)
    ], actionNodes[0] ? actionNodes[0].props.press : null);
  }

  function renderSnapshot(surface, lifecycleKey) {
    var screens = [
      rootScreen(surface),
      builderScreen(surface),
      settingsScreen(surface),
      previewScreen(surface),
      shareScreen(surface),
      detailScreen(surface),
      followUpScreen(surface)
    ];
    return {
      schema: 'bitfield.native.view.snapshot',
      package: PACKAGE_NAME,
      lifecycle_key: lifecycleKey,
      root: stack('vertical', 0, screens.map(function (entry) { return entry.root; }), { fillWidth: true }, 'request-intake:jscore'),
      navigation: {
        mode: 'one-task-per-screen',
        screens: screens
      },
      coverage: {
        status: surface.status,
        shape_ids: surface.shapes.map(function (entry) { return entry.id; }),
        view_ids: surface.views.map(function (entry) { return entry.id; }),
        action_ids: surface.actions.map(function (entry) { return entry.id; }),
        record_ids: surface.records.map(function (entry) { return entry.id; }),
        receipt_count: surface.receipts.length,
        issue_count: surface.issues.length
      }
    };
  }

  var activeBridge = null;

  function mount(mountRecord, bridge) {
    activeBridge = bridge;
    var record = objectOrEmpty(mountRecord);
    var lifecycleKey = readString(record.lifecycle_key || record.lifecycleKey, 'component:request-intake:jscore');
    var surface = loadSurface(record, bridge);
    var snapshot = renderSnapshot(surface, lifecycleKey);
    bridge.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    if (typeof console !== 'undefined' && console.info) {
      console.info('[request-intake] jscore surface mounted', { status: surface.status, screens: snapshot.navigation.screens.length });
    }
    return {
      dispose: function () {
        bridge.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycleKey }));
      },
      snapshot: function () {
        return snapshot;
      }
    };
  }

  function onAction(actionText) {
    if (!activeBridge) return null;
    var action = typeof actionText === 'string' ? JSON.parse(actionText) : objectOrEmpty(actionText);
    if (action.operation !== TARGET_INVOKE_OPERATION) return null;
    if (typeof console !== 'undefined' && console.info) {
      console.info('[request-intake] jscore requested owner action', objectOrEmpty(action.payload).target);
    }
    return activeBridge.invoke(TARGET_INVOKE_OPERATION, JSON.stringify(action.payload));
  }

  globalThis.bitfieldMount = mount;
  globalThis.bitfieldOnAction = onAction;
  globalThis.RequestIntakeJscore = {
    normalizeSurface: normalizeSurface,
    renderSnapshot: renderSnapshot,
    actionContext: actionContext
  };
})();
