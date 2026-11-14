(function () {
  var PACKAGE_NAME = 'bitfield-package-store-catalog';
  var INPUT_NAME = 'record-action-projection';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var DEFAULT_LIFECYCLE_KEY = 'component:bitfield-package-store-catalog:jscore';

  var STATE_COPY = {
    ready: { label: 'Ready', detail: 'Items are available.', tone: 'neutral' },
    dense: { label: 'Ready', detail: 'Many items are available.', tone: 'neutral' },
    sparse: { label: 'Ready', detail: 'A few items are available.', tone: 'neutral' },
    empty: { label: 'Empty', detail: 'Nothing is available yet.', tone: 'muted' },
    loading: { label: 'Loading', detail: 'Waiting for items.', tone: 'muted' },
    error: { label: 'Needs attention', detail: 'The latest items could not be read.', tone: 'error' },
    offline: { label: 'Offline', detail: 'Saved items stay visible. New actions wait for sync.', tone: 'warning' }
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

  function readNumber(value, fallback) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      var parsed = Number(value);
      if (isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function node(kind, props, children, id) {
    var built = { kind: kind, props: objectOrEmpty(props), children: arrayOrEmpty(children).filter(Boolean) };
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

  function stack(axis, spacing, children, props) {
    var merged = objectOrEmpty(props);
    merged.axis = axis || 'vertical';
    merged.spacing = spacing || 0;
    return node('stack', merged, children);
  }

  function box(children, props, id) {
    return node('box', Object.assign({
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 12,
      spacing: 8
    }, objectOrEmpty(props)), children, id);
  }

  function valueText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i += 1) {
        var child = valueText(value[i]);
        if (child) parts.push(child);
      }
      return parts.join(', ');
    }
    var row = objectOrEmpty(value);
    var keys = ['label', 'title', 'name', 'id'];
    for (var j = 0; j < keys.length; j += 1) {
      var keyed = valueText(row[keys[j]]);
      if (keyed) return keyed;
    }
    return JSON.stringify(value);
  }

  function compactBlocks(blocks, maxCount) {
    return arrayOrEmpty(blocks).slice(0, maxCount).map(function (block, index) {
      var row = objectOrEmpty(block);
      return {
        id: readString(row.id, 'block:' + String(index + 1)),
        renderKind: readString(row.render_kind, 'text'),
        role: readString(row.role, 'text'),
        label: readString(row.label),
        value: valueText(row.value || row.values),
        toneKey: readString(row.tone_key)
      };
    }).filter(function (block) {
      return block.value || block.label;
    });
  }

  function normalizeAction(action, index) {
    var row = objectOrEmpty(action);
    return {
      id: readString(row.id, 'action:' + String(index + 1)),
      role: readString(row.role, 'action'),
      label: readString(row.label, 'Continue'),
      target: readString(row.target),
      input: objectOrEmpty(row.input),
      subject: objectOrEmpty(row.subject),
      disabledReason: readString(row.disabled_reason || row.disabledReason),
      provenance: objectOrEmpty(row.provenance)
    };
  }

  function normalizeRecord(record, index) {
    var row = objectOrEmpty(record);
    var actions = arrayOrEmpty(row.actions).map(normalizeAction);
    return {
      recordRef: readString(row.record_ref, 'record:' + String(index + 1)),
      primaryText: readString(row.primary_text, 'Item'),
      secondaryText: readString(row.secondary_text),
      sortKey: readString(row.sort_key, String(index).padStart(6, '0')),
      blocks: compactBlocks(row.blocks, 8),
      actions: actions,
      relationshipCount: Object.keys(objectOrEmpty(row.relationships)).reduce(function (total, key) {
        return total + arrayOrEmpty(objectOrEmpty(row.relationships)[key]).length;
      }, 0),
      provenance: objectOrEmpty(row.provenance)
    };
  }

  function normalizeIntent(intent, index) {
    var row = objectOrEmpty(intent);
    return {
      id: readString(row.id || row.intent_id, 'intent:' + String(index + 1)),
      label: readString(row.label || row.action_label, 'Pending action'),
      stateLabel: readString(row.state_label || row.status_label, 'Waiting'),
      target: readString(row.target),
      actionId: readString(row.action_id),
      recordRef: readString(row.record_ref)
    };
  }

  function firstList() {
    for (var i = 0; i < arguments.length; i += 1) {
      var list = arrayOrEmpty(arguments[i]);
      if (list.length > 0) return list;
    }
    return [];
  }

  function normalizeProjection(value) {
    var projection = objectOrEmpty(value);
    var metadata = objectOrEmpty(projection.metadata);
    var records = arrayOrEmpty(projection.records).map(normalizeRecord).sort(function (left, right) {
      return left.sortKey.localeCompare(right.sortKey);
    });
    var givenState = readString(projection.state);
    return {
      schema: readString(projection.schema, 'generic.record_action_projection.v1'),
      projectionId: readString(projection.projection_id, 'projection:unknown'),
      state: givenState || (records.length > 0 ? 'ready' : 'empty'),
      records: records,
      queuedIntents: firstList(projection.queued_action_intents, metadata.queued_action_intents).map(normalizeIntent),
      resolvedIntents: firstList(projection.sync_resolved_action_intents, metadata.sync_resolved_action_intents).map(normalizeIntent),
      error: readString(projection.error),
      provenance: objectOrEmpty(projection.provenance)
    };
  }

  function stateView(model) {
    var copy = STATE_COPY[model.state] || {
      label: model.state || 'Ready',
      detail: model.error || 'Items are available.',
      tone: 'neutral'
    };
    return {
      label: model.error || copy.label,
      detail: model.error || copy.detail,
      tone: copy.tone
    };
  }

  function ownerActionIntent(action, record, mode) {
    var row = objectOrEmpty(action);
    var selected = objectOrEmpty(record);
    return {
      schema: 'generic.owner_action_intent.v1',
      mode: readString(mode, 'invoke'),
      target: readString(row.target),
      action_id: readString(row.id),
      method: readString(row.role || row.id, 'action'),
      input: objectOrEmpty(row.input),
      subject: objectOrEmpty(row.subject),
      selected_record_refs: selected.recordRef ? [{ record_ref: selected.recordRef }] : [],
      provenance: objectOrEmpty(row.provenance)
    };
  }

  function actionPress(action, record) {
    if (!action.target || action.disabledReason) return null;
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: action.target,
        payload: ownerActionIntent(action, record, 'invoke')
      }
    };
  }

  function toneBox(tone) {
    if (tone === 'error') return { background: '#3a1717', border: '#cc4b4b', text: '#ff8f8f' };
    if (tone === 'warning') return { background: '#493715', border: '#9a6b18', text: '#f0c36a' };
    if (tone === 'muted') return { background: 'darkSurfaceRaised', border: 'darkBorder', text: 'darkTextSecondary' };
    return { background: 'darkSurfaceRaised', border: 'accent', text: 'accent' };
  }

  function blockNode(block) {
    var label = block.label ? block.label + ': ' : '';
    if (block.renderKind === 'mark') {
      return box([text(label + block.value, 11, 'semibold', 'darkTextSecondary', 1)], {
        background: 'darkSurfaceRaised',
        cornerRadius: 999,
        padding: 7,
        fillWidth: false,
        toneKey: block.toneKey || null
      }, block.id);
    }
    if (block.renderKind === 'metric') {
      return box([
        text(block.value, 18, 'bold', 'darkTextPrimary', 1),
        block.label ? text(block.label, 11, 'regular', 'darkTextSecondary', 1) : null
      ], { background: 'darkSurfaceRaised', padding: 9 }, block.id);
    }
    if (block.renderKind === 'media') {
      return node('media', {
        label: block.label || block.role,
        value: block.value,
        toneKey: block.toneKey || null
      }, [], block.id);
    }
    return text(label + block.value, 12, 'regular', 'darkTextSecondary', 2);
  }

  function actionNode(action, record, primary) {
    return box([text(action.disabledReason || action.label, 12, 'semibold', primary ? 'accent' : 'darkTextPrimary', 1)], {
      background: primary && !action.disabledReason ? '#12315a' : 'darkSurfaceRaised',
      border: primary && !action.disabledReason ? 'accent' : 'darkBorder',
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      disabledReason: action.disabledReason || null,
      press: actionPress(action, record)
    }, action.id);
  }

  function cardNode(record, index) {
    var blocks = record.blocks.slice(0, 4).map(blockNode);
    var actions = record.actions.slice(0, 2).map(function (action, actionIndex) {
      return actionNode(action, record, actionIndex === 0);
    });
    return box([
      text(record.primaryText, 18, 'bold', 'darkTextPrimary', 2),
      record.secondaryText ? text(record.secondaryText, 13, 'regular', 'darkTextSecondary', 3) : null,
      stack('horizontal', 6, blocks, { wrap: true }),
      actions.length ? stack('horizontal', 7, actions, { wrap: true }) : null
    ], {
      background: index === 0 ? 'darkSurfaceRaised' : 'darkSurface',
      accessibilityLabel: record.primaryText
    }, record.recordRef);
  }

  function intentNode(intent, resolved) {
    return box([
      text(intent.label, 13, 'semibold', 'darkTextPrimary', 1),
      text(resolved ? 'Synced' : intent.stateLabel, 12, 'regular', 'darkTextSecondary', 1)
    ], { background: resolved ? '#10351f' : '#493715', border: resolved ? '#2aa15f' : '#9a6b18' }, intent.id);
  }

  function renderNativeSnapshot(projectionInput, lifecycleKey) {
    var model = normalizeProjection(projectionInput);
    var status = stateView(model);
    var statusStyle = toneBox(status.tone);
    var selected = model.records[0] || null;
    var cards = model.records.slice(0, 12).map(cardNode);
    var children = [
      text('Package List', 30, 'bold', 'darkTextPrimary', 2),
      box([
        text(status.label, 13, 'semibold', statusStyle.text, 1),
        text(status.detail, 12, 'regular', 'darkTextSecondary', 2)
      ], { background: statusStyle.background, border: statusStyle.border }),
      cards.length ? stack('vertical', 10, cards) : box([
        text(status.detail, 14, 'regular', 'darkTextSecondary', 2)
      ], { background: 'darkSurfaceRaised' })
    ];

    if (selected) {
      children.push(box([
        text(selected.primaryText, 22, 'bold', 'darkTextPrimary', 2),
        selected.secondaryText ? text(selected.secondaryText, 13, 'regular', 'darkTextSecondary', 4) : null,
        stack('vertical', 6, selected.blocks.map(blockNode)),
        selected.actions.length ? stack('horizontal', 7, selected.actions.map(function (action, index) {
          return actionNode(action, selected, index === 0);
        }), { wrap: true }) : null
      ], { background: 'darkSurfaceRaised' }, selected.recordRef + ':detail'));
    }

    if (model.queuedIntents.length || model.resolvedIntents.length) {
      children.push(box([
        text('Action sync', 14, 'bold', 'darkTextPrimary', 1),
        stack('vertical', 6, model.queuedIntents.map(function (intent) { return intentNode(intent, false); })
          .concat(model.resolvedIntents.map(function (intent) { return intentNode(intent, true); })))
      ], { background: 'darkSurface' }));
    }

    return {
      schema: 'bitfield.native.view.snapshot',
      descriptor_schema: model.schema,
      lifecycle_key: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
      coverage: {
        projection_id: model.projectionId,
        state: model.state,
        record_count: model.records.length,
        action_count: model.records.reduce(function (total, record) { return total + record.actions.length; }, 0),
        block_count: model.records.reduce(function (total, record) { return total + record.blocks.length; }, 0),
        queued_intent_count: model.queuedIntents.length,
        resolved_intent_count: model.resolvedIntents.length
      },
      root: node('screen', {
        lifecycleKey: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
        background: 'darkBackground',
        minHeight: 900,
        padding: 18,
        spacing: 12
      }, [stack('vertical', 12, children, { maxWidth: 720 })])
    };
  }

  function readPackageInput(bridge) {
    if (!bridge || typeof bridge.invoke !== 'function') return null;
    var responseText = bridge.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: INPUT_NAME
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found !== false ? reply.value : null;
    } catch (_error) {
      return null;
    }
  }

  function mountCatalog(mountRecord, bridge) {
    var record = objectOrEmpty(mountRecord);
    var props = objectOrEmpty(record.props);
    var lifecycleKey = readString(record.lifecycle_key || props.lifecycle_key, DEFAULT_LIFECYCLE_KEY);
    var projection = props.projection || record.projection || readPackageInput(bridge) || {};
    var snapshot = renderNativeSnapshot(projection, lifecycleKey);
    bridge.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    if (typeof console !== 'undefined' && console.info) {
      console.info('[bitfield-package-store-catalog] ios read generic projection');
    }
    return {
      dispose: function () {
        bridge.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycleKey }));
      }
    };
  }

  globalThis.BitfieldPackageStoreCatalogJscore = {
    normalizeProjection: normalizeProjection,
    ownerActionIntent: ownerActionIntent,
    renderNativeSnapshot: renderNativeSnapshot,
    mountCatalog: mountCatalog
  };
  globalThis.bitfieldMount = mountCatalog;
  globalThis.putThingOnScreen = mountCatalog;
}());
