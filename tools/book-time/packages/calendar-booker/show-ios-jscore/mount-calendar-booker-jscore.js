// Purpose: JavaScriptCore realization entry for the calendar-booker owner-action surface.
// The native mount consumes the same owner-translated ViewDescriptor[] payload as
// the browser surface and emits sealed native snapshot/action operations.

(function () {
  var PACKAGE_NAME = 'calendar-booker';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var MOUNT_ACTION_OPERATION = 'screen.mount.action';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var WORKFLOW_TARGET = 'slot::workflow';
  var DEFAULT_LIFECYCLE_KEY = 'component:calendar-booker:jscore';
  var VIEW_DESCRIPTOR_INPUTS = [
    'calendar-booker-view-descriptors',
    'booking-links-view-descriptors'
  ];
  var ACTION_DESCRIPTOR_INPUTS = [
    'calendar-booker-action-descriptors',
    'owner-action-descriptors'
  ];
  var SCREEN_LOOK_INPUT = 'screen-look-tokens';
  var SHARED_CONTRACT_SOURCE_PATHS = [
    'show/view-descriptor.ts',
    'show/render-capability-map.tsx',
    'show/descriptor-surface.tsx',
    'do-work/scheduling-offer-feed.ts'
  ];

  var RENDER_KIND_KEYS = [
    'group',
    'field.text',
    'field.number',
    'field.datetime',
    'field.structured',
    'field.list',
    'chips.single-select',
    'status.row',
    'status.card',
    'action.bar',
    'preview.embed',
    'table'
  ];

  var currentMount = null;
  var currentProps = {};
  var currentViews = [];
  var currentActionDescriptors = [];
  var currentTokens = {};
  var selectedValuesByNode = {};
  var actionSequence = 0;

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value, fallback) {
    return typeof value === 'string' && value.length > 0 ? value : (fallback || '');
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function lifecycleKey(record) {
    return readString(objectOrEmpty(record).lifecycle_key, DEFAULT_LIFECYCLE_KEY);
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

  function stack(axis, spacing, children, props, id) {
    var merged = objectOrEmpty(props);
    merged.axis = axis;
    merged.spacing = spacing;
    return node('stack', merged, children, id);
  }

  function box(props, children, id) {
    return node('box', props, children, id);
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value || ''),
      size: size,
      weight: weight || 'regular',
      color: color || 'textPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function readPackageInput(mount, inputName) {
    if (!mount || typeof mount.invoke !== 'function') return null;
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

  function normalizeViews(value) {
    if (Array.isArray(value)) return value;
    var record = objectOrEmpty(value);
    if (Array.isArray(record.views)) return record.views;
    if (Array.isArray(record.view_descriptors)) return record.view_descriptors;
    if (Array.isArray(record.descriptors)) return record.descriptors;
    if (record.root && typeof record.root === 'object') return [record.root];
    return [];
  }

  function readViews(props, mount) {
    var nestedProps = objectOrEmpty(props.props);
    var direct = normalizeViews(
      props.views || props.view_descriptors || props.descriptors || props.root
        || nestedProps.views || nestedProps.view_descriptors || nestedProps.descriptors || nestedProps.root
    );
    if (direct.length > 0) return direct;
    for (var index = 0; index < VIEW_DESCRIPTOR_INPUTS.length; index += 1) {
      var fromInput = normalizeViews(readPackageInput(mount, VIEW_DESCRIPTOR_INPUTS[index]));
      if (fromInput.length > 0) return fromInput;
    }
    return [];
  }

  function normalizeActionDescriptors(value) {
    var list = Array.isArray(value)
      ? value
      : arrayOrEmpty(objectOrEmpty(value).actionDescriptors || objectOrEmpty(value).action_descriptors || objectOrEmpty(value).descriptors);
    return list.map(objectOrEmpty).filter(function (record) {
      return record.kind === 'owner_action_descriptor' && typeof record.action_ref === 'string';
    });
  }

  function readActionDescriptors(props, mount) {
    var nestedProps = objectOrEmpty(props.props);
    var direct = normalizeActionDescriptors(
      props.actionDescriptors || props.action_descriptors || props.owner_action_descriptors || props.descriptors || props.model
        || nestedProps.actionDescriptors || nestedProps.action_descriptors || nestedProps.owner_action_descriptors || nestedProps.descriptors || nestedProps.model
    );
    if (direct.length > 0) return direct;
    for (var index = 0; index < ACTION_DESCRIPTOR_INPUTS.length; index += 1) {
      var fromInput = normalizeActionDescriptors(readPackageInput(mount, ACTION_DESCRIPTOR_INPUTS[index]));
      if (fromInput.length > 0) return fromInput;
    }
    return [];
  }

  function readScreenLook(props, mount) {
    var nestedProps = objectOrEmpty(props.props);
    var direct = objectOrEmpty(props.screenLook || props.screen_look || props.tokens || nestedProps.screenLook || nestedProps.screen_look || nestedProps.tokens);
    if (Object.keys(direct).length > 0) return direct;
    return objectOrEmpty(readPackageInput(mount, SCREEN_LOOK_INPUT));
  }

  function descriptorBytes(views) {
    return JSON.stringify(views);
  }

  function descriptorValue(nodeRecord) {
    var nodeId = readString(nodeRecord.id);
    if (nodeId && Object.prototype.hasOwnProperty.call(selectedValuesByNode, nodeId)) {
      return selectedValuesByNode[nodeId];
    }
    return nodeRecord.value;
  }

  function valueText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function normalizeActionRef(ref) {
    var flattened = String(ref || '').replace(/::/g, ':');
    var parts = flattened.split(':');
    var last = parts[parts.length - 1] || flattened;
    var dotted = last.split('.');
    return dotted[dotted.length - 1] || last;
  }

  function descriptorActionSlugs(descriptor) {
    var record = objectOrEmpty(descriptor);
    var refs = [
      record.descriptor_id,
      record.action_ref,
      record.source_record_ref
    ];
    var productRefs = arrayOrEmpty(record.product_action_refs);
    for (var index = 0; index < productRefs.length; index += 1) refs.push(productRefs[index]);
    var out = {};
    for (var refIndex = 0; refIndex < refs.length; refIndex += 1) {
      if (typeof refs[refIndex] === 'string' && refs[refIndex].trim()) {
        out[normalizeActionRef(refs[refIndex])] = true;
      }
    }
    return out;
  }

  function findActionDescriptor(intentRef) {
    for (var exactIndex = 0; exactIndex < currentActionDescriptors.length; exactIndex += 1) {
      var exact = objectOrEmpty(currentActionDescriptors[exactIndex]);
      if (exact.descriptor_id === intentRef || exact.action_ref === intentRef) return exact;
    }
    var intentSlug = normalizeActionRef(intentRef);
    for (var slugIndex = 0; slugIndex < currentActionDescriptors.length; slugIndex += 1) {
      var descriptor = objectOrEmpty(currentActionDescriptors[slugIndex]);
      if (descriptorActionSlugs(descriptor)[intentSlug]) return descriptor;
    }
    return null;
  }

  function mergedActionInput(descriptor, action, sourceNode) {
    var input = {};
    var sources = [
      objectOrEmpty(descriptor.context),
      objectOrEmpty(descriptor.input),
      objectOrEmpty(action.input)
    ];
    for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      var source = sources[sourceIndex];
      var keys = Object.keys(source);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        input[keys[keyIndex]] = source[keys[keyIndex]];
      }
    }
    input.intent_ref = readString(action.action_ref);
    input.source_node_id = readString(sourceNode.id);
    actionSequence += 1;
    input.correlation_id = 'native-jscore:' + lifecycleKey(currentProps) + ':' + String(actionSequence);
    return input;
  }

  function actionPress(action, sourceNode) {
    var record = objectOrEmpty(action);
    var ref = readString(record.action_ref);
    if (!ref || record.disabled_reason) return null;
    var descriptor = findActionDescriptor(ref);
    if (!descriptor) return null;
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: readString(descriptor.target, WORKFLOW_TARGET),
        payload: {
          operation: 'execute_definition',
          definition_id: readString(descriptor.action_ref),
          include_steps: readBoolean(descriptor.include_steps, false),
          include_output: readBoolean(descriptor.include_output, false),
          input: mergedActionInput(descriptor, record, sourceNode)
        }
      }
    };
  }

  function valuePress(nodeRecord, value) {
    return {
      operation: MOUNT_ACTION_OPERATION,
      payload: {
        type: 'descriptor-value-change',
        node_id: readString(nodeRecord.id),
        value: value
      }
    };
  }

  function statusLine(nodeRecord) {
    var status = objectOrEmpty(nodeRecord.status);
    var label = readString(status.label);
    if (!label) return null;
    var tone = readString(status.tone_ref, 'neutral');
    var children = [
      box({
        role: 'status-dot',
        tone: tone,
        background: tone
      }, [], readString(nodeRecord.id) + ':dot'),
      text(label, 14, 'semibold', 'textPrimary')
    ];
    var reason = readString(status.reason);
    var body = [stack('horizontal', 8, children, { alignItems: 'center' })];
    if (reason) body.push(text(reason, 12, 'regular', 'textSecondary'));
    return stack('vertical', 4, body, { role: 'status' }, readString(nodeRecord.id) + ':status');
  }

  function renderChildren(nodeRecord, caps) {
    return arrayOrEmpty(nodeRecord.children).map(function (child) {
      return renderDescriptor(child, caps);
    });
  }

  function renderLabelAndHelp(nodeRecord, headingSize) {
    var parts = [];
    var label = readString(nodeRecord.label);
    var help = readString(nodeRecord.help);
    if (label) parts.push(text(label, headingSize || 15, 'semibold', 'textPrimary'));
    if (help) parts.push(text(help, 12, 'regular', 'textSecondary'));
    return parts;
  }

  function renderGroup(nodeRecord, caps) {
    return stack(
      'vertical',
      10,
      renderLabelAndHelp(nodeRecord, 16).concat(renderChildren(nodeRecord, caps)),
      { role: 'group' },
      readString(nodeRecord.id)
    );
  }

  function renderPreview(nodeRecord, caps) {
    return box({
      role: 'preview',
      background: 'surfaceRaised',
      border: 'border',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 12
    }, [renderGroup(nodeRecord, caps)], readString(nodeRecord.id));
  }

  function renderField(nodeRecord, inputKind) {
    var label = readString(nodeRecord.label);
    var help = readString(nodeRecord.help);
    var value = descriptorValue(nodeRecord);
    var children = [];
    if (label) children.push(text(label, 12, 'semibold', 'textSecondary', 1));
    if (valueText(value)) children.push(text(valueText(value), 14, 'regular', 'textPrimary', 2));
    if (help) children.push(text(help, 12, 'regular', 'textSecondary', 2));
    return node('field', {
      label: label,
      value: valueText(value),
      inputKind: inputKind,
      editable: readBoolean(nodeRecord.editable, true),
      hint: help
    }, children, readString(nodeRecord.id));
  }

  function renderStructuredField(nodeRecord) {
    var labelParts = renderLabelAndHelp(nodeRecord, 14);
    var value = descriptorValue(nodeRecord);
    var rows = arrayOrEmpty(value).map(function (row, index) {
      var record = objectOrEmpty(row);
      return stack('horizontal', 8, [
        text(readString(record.label, readString(record.key, 'Item')), 12, 'semibold', 'textSecondary', 1),
        text(valueText(record.value), 12, 'regular', 'textPrimary', 2)
      ], { role: 'structured-row' }, readString(record.id, 'structured-' + String(index)));
    });
    if (rows.length === 0 && valueText(value)) rows.push(text(valueText(value), 13, 'regular', 'textPrimary'));
    return stack('vertical', 6, labelParts.concat(rows), {
      role: 'structured-field',
      editable: readBoolean(nodeRecord.editable, true)
    }, readString(nodeRecord.id));
  }

  function renderFieldList(nodeRecord) {
    var rows = arrayOrEmpty(descriptorValue(nodeRecord)).map(function (row, index) {
      var record = objectOrEmpty(row);
      return stack('horizontal', 8, [
        text(readString(record.label, 'Item'), 12, 'semibold', 'textSecondary', 1),
        text(valueText(record.value), 12, 'regular', 'textPrimary', 2)
      ], { role: 'field-list-row' }, readString(record.id, 'field-list-' + String(index)));
    });
    return stack('vertical', 6, renderLabelAndHelp(nodeRecord, 14).concat(rows), {
      role: 'field-list'
    }, readString(nodeRecord.id));
  }

  function renderChips(nodeRecord) {
    var selected = valueText(descriptorValue(nodeRecord));
    var chips = arrayOrEmpty(nodeRecord.options).map(function (option) {
      var record = objectOrEmpty(option);
      var value = readString(record.value);
      var label = readString(record.label, value);
      var isSelected = selected === value;
      return box({
        role: 'chip',
        selected: isSelected,
        background: isSelected ? 'accentSoft' : 'surfaceRaised',
        border: isSelected ? 'accent' : 'border',
        borderWidth: 1,
        cornerRadius: 999,
        padding: 10,
        press: valuePress(nodeRecord, value)
      }, [text(label, 13, 'semibold', isSelected ? 'accent' : 'textPrimary', 1)], readString(nodeRecord.id) + ':' + value);
    });
    return stack(
      'vertical',
      6,
      renderLabelAndHelp(nodeRecord, 14).concat([
        stack('horizontal', 8, chips, { wrap: true, role: 'chip-row' })
      ]),
      { role: 'chips' },
      readString(nodeRecord.id)
    );
  }

  function renderStatusRow(nodeRecord) {
    var children = renderLabelAndHelp(nodeRecord, 14);
    var status = statusLine(nodeRecord);
    if (status) children.push(status);
    return stack('vertical', 6, children, { role: 'status-row' }, readString(nodeRecord.id));
  }

  function renderStatusCard(nodeRecord, caps) {
    var status = statusLine(nodeRecord);
    var children = renderLabelAndHelp(nodeRecord, 15);
    if (status) children.push(status);
    return box({
      role: 'status-card',
      background: 'surfaceRaised',
      border: 'border',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 12
    }, [stack('vertical', 8, children.concat(renderChildren(nodeRecord, caps)))], readString(nodeRecord.id));
  }

  function renderActionBar(nodeRecord) {
    var actions = arrayOrEmpty(nodeRecord.actions).map(function (action, index) {
      var record = objectOrEmpty(action);
      var disabledReason = readString(record.disabled_reason);
      var press = actionPress(record, nodeRecord);
      return box({
        role: 'action',
        background: press ? 'accentSoft' : 'surfaceDisabled',
        border: press ? 'accent' : 'border',
        borderWidth: 1,
        cornerRadius: 12,
        padding: 11,
        disabled: !press,
        disabledReason: disabledReason,
        press: press
      }, [text(readString(record.label, 'Continue'), 13, 'semibold', press ? 'accent' : 'textSecondary', 1)], readString(nodeRecord.id) + ':action:' + String(index));
    });
    return stack('horizontal', 8, actions, { wrap: true, role: 'action-bar' }, readString(nodeRecord.id));
  }

  function renderTable(nodeRecord) {
    var value = objectOrEmpty(descriptorValue(nodeRecord));
    var columns = arrayOrEmpty(value.columns).map(function (column) {
      var record = objectOrEmpty(column);
      return { key: readString(record.key), label: readString(record.label) };
    }).filter(function (column) { return column.key; });
    var rows = arrayOrEmpty(value.rows).map(function (row) { return objectOrEmpty(row); });
    return node('table', {
      columns: columns,
      rows: rows,
      role: 'table'
    }, [], readString(nodeRecord.id));
  }

  function renderUnknown(nodeRecord) {
    return box({
      role: 'unknown-descriptor',
      source_node_id: readString(nodeRecord.id),
      cornerRadius: 12,
      border: 'border',
      borderWidth: 1,
      padding: 12
    }, renderLabelAndHelp(nodeRecord, 14).concat([
      text('This part is not available in this view yet.', 13, 'regular', 'textSecondary')
    ]), readString(nodeRecord.id));
  }

  var RENDER_CAPABILITIES = {
    'group': renderGroup,
    'field.text': function (nodeRecord) { return renderField(nodeRecord, 'text'); },
    'field.number': function (nodeRecord) { return renderField(nodeRecord, 'number'); },
    'field.datetime': function (nodeRecord) { return renderField(nodeRecord, 'datetime'); },
    'field.structured': renderStructuredField,
    'field.list': renderFieldList,
    'chips.single-select': renderChips,
    'status.row': renderStatusRow,
    'status.card': renderStatusCard,
    'action.bar': renderActionBar,
    'preview.embed': renderPreview,
    'table': renderTable
  };

  function renderDescriptor(rawNode, caps) {
    var nodeRecord = objectOrEmpty(rawNode);
    var render = caps[readString(nodeRecord.render_kind)];
    return render ? render(nodeRecord, caps) : renderUnknown(nodeRecord);
  }

  function renderRoot(views, lifecycle, tokens) {
    var children = views.map(function (view) {
      return renderDescriptor(view, RENDER_CAPABILITIES);
    });
    if (children.length === 0) {
      children.push(box({
        role: 'empty',
        cornerRadius: 12,
        border: 'border',
        borderWidth: 1,
        padding: 14
      }, [text('Nothing here yet.', 14, 'regular', 'textSecondary')]));
    }
    return stack('vertical', 12, children, {
      role: 'calendar-booker-jscore-root',
      lifecycle_key: lifecycle,
      tokens: tokens,
      padding: 16,
      safeArea: true
    }, lifecycle + ':root');
  }

  function replaceSnapshot(mount, props, views, tokens) {
    var lifecycle = lifecycleKey(props);
    var snapshot = {
      package_name: PACKAGE_NAME,
      lifecycle_key: lifecycle,
      descriptor_bytes: descriptorBytes(views),
      shared_contract_source_paths: SHARED_CONTRACT_SOURCE_PATHS.slice(),
      root: renderRoot(views, lifecycle, tokens)
    };
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    return snapshot;
  }

  function remount() {
    if (!currentMount) return null;
    return replaceSnapshot(currentMount, currentProps, currentViews, currentTokens);
  }

  function handleMountAction(action) {
    var record = objectOrEmpty(action);
    if (record.type !== 'descriptor-value-change') return null;
    var nodeId = readString(record.node_id);
    if (!nodeId) return null;
    selectedValuesByNode[nodeId] = record.value;
    return remount();
  }

  function bitfieldMount(props, mount) {
    currentProps = objectOrEmpty(props);
    currentMount = mount;
    selectedValuesByNode = {};
    actionSequence = 0;
    currentViews = readViews(currentProps, mount);
    currentActionDescriptors = readActionDescriptors(currentProps, mount);
    currentTokens = readScreenLook(currentProps, mount);
    var snapshot = replaceSnapshot(mount, currentProps, currentViews, currentTokens);
    console.info('[calendar-booker/ios] mounted ' + String(currentViews.length) + ' descriptor roots');
    return {
      dispose: function () {
        if (mount && typeof mount.invoke === 'function') {
          mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({
            package_name: PACKAGE_NAME,
            lifecycle_key: lifecycleKey(currentProps)
          }));
        }
      },
      snapshot: function () {
        return snapshot;
      }
    };
  }

  globalThis.bitfieldOnAction = function (payloadText) {
    try {
      return handleMountAction(JSON.parse(payloadText));
    } catch (error) {
      return null;
    }
  };

  globalThis.CalendarBookerJscore = {
    packageName: PACKAGE_NAME,
    sharedContractSourcePaths: SHARED_CONTRACT_SOURCE_PATHS.slice(),
    renderKindKeys: function () { return RENDER_KIND_KEYS.slice(); },
    descriptorBytes: descriptorBytes,
    renderNativeSnapshot: function (views, lifecycle, tokens) {
      return {
        package_name: PACKAGE_NAME,
        lifecycle_key: lifecycle || DEFAULT_LIFECYCLE_KEY,
        descriptor_bytes: descriptorBytes(normalizeViews(views)),
        shared_contract_source_paths: SHARED_CONTRACT_SOURCE_PATHS.slice(),
        root: renderRoot(normalizeViews(views), lifecycle || DEFAULT_LIFECYCLE_KEY, objectOrEmpty(tokens))
      };
    }
  };

  globalThis.bitfieldMount = bitfieldMount;
}());
