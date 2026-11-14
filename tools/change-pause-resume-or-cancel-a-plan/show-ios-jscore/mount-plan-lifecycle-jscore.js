// Purpose: JavaScriptCore renderer for the plan-lifecycle package.
// Invariants: consumes the shared Surface Descriptor, imports no web framework,
// and emits sealed native screen snapshot operations only.

(function () {
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var MOUNT_ACTION_OPERATION = 'screen.mount.action';
  var DEFAULT_LIFECYCLE_KEY = 'component:plan-lifecycle:jscore';
  var SECTION_KIND_CONTRACT = [
    'header',
    'summaryStrip',
    'detailGroup',
    'optionGroup',
    'actionRail',
    'confirmation',
    'outcome',
    'problemList',
    'empty',
    'loading',
    'error'
  ];

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

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean)
    };
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

  function box(children, props) {
    return node('box', Object.assign({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 12,
      spacing: 8
    }, objectOrEmpty(props)), children);
  }

  function actionPress(action) {
    return {
      operation: MOUNT_ACTION_OPERATION,
      payload: {
        kind: 'surface.action',
        action_id: readString(action.id),
        enabled: action.enabled !== false
      }
    };
  }

  function actionButton(action) {
    var enabled = action.enabled !== false;
    var intent = readString(action.intent, 'neutral');
    var primary = intent === 'primary';
    var quiet = intent === 'quiet';
    var destructive = intent === 'destructive';
    return box([text(action.label, 12, 'semibold', enabled ? (destructive ? '#ff8f8f' : primary ? 'accent' : 'darkTextPrimary') : 'darkTextSecondary', 1)], {
      background: enabled && primary ? '#12315a' : enabled && destructive ? '#3a1717' : quiet ? 'darkSurface' : 'darkSurfaceRaised',
      border: enabled && primary ? 'accent' : enabled && destructive ? '#cc4b4b' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      press: enabled ? actionPress(action) : null,
      disabledReason: readString(action.disabledReason || action.disabled_reason)
    });
  }

  function rowText(row) {
    var item = objectOrEmpty(row);
    var label = readString(item.label);
    var value = readString(item.value);
    return text(label && value ? label + ': ' + value : label || value, 12, 'regular', 'darkTextSecondary', 2);
  }

  function sectionTitle(value) {
    return text(value, 14, 'bold', 'darkTextPrimary', 2);
  }

  function renderSection(section) {
    var source = objectOrEmpty(section);
    switch (readString(source.kind, 'empty')) {
      case 'header':
        return box([
          text(source.title, 28, 'bold', 'darkTextPrimary', 2),
          source.explanation ? text(source.explanation, 13, 'regular', 'darkTextSecondary', 3) : null,
          objectOrEmpty(source.freshness).label ? text(objectOrEmpty(source.freshness).label, 11, 'regular', 'darkTextSecondary', 1) : null
        ], { background: 'darkSurface' });
      case 'summaryStrip':
        return stack('horizontal', 8, arrayOrEmpty(source.stats).map(function (stat) {
          var row = objectOrEmpty(stat);
          return box([
            text(row.value, 16, 'bold', 'darkTextPrimary', 1),
            text(row.label, 11, 'regular', 'darkTextSecondary', 1)
          ], { fillWidth: true });
        }), { wrap: true });
      case 'detailGroup':
        return box([sectionTitle(source.title)].concat(arrayOrEmpty(source.rows).map(rowText)));
      case 'optionGroup':
        return box([sectionTitle(source.title)].concat(arrayOrEmpty(source.options).map(function (option) {
          var row = objectOrEmpty(option);
          return box([
            text(row.title, 15, 'bold', 'darkTextPrimary', 2),
            row.priceText ? text(row.priceText, 12, 'regular', 'darkTextSecondary', 1) : null
          ].concat(arrayOrEmpty(row.lines).map(rowText)).concat([actionButton(objectOrEmpty(row.action))]), { background: 'darkSurface' });
        })));
      case 'actionRail':
        return stack('horizontal', 8, arrayOrEmpty(source.actions).map(function (action) {
          return actionButton(objectOrEmpty(action));
        }), { horizontalScroll: true });
      case 'confirmation':
        return box([
          sectionTitle(source.title),
          source.explanation ? text(source.explanation, 12, 'regular', 'darkTextSecondary', 3) : null
        ].concat(arrayOrEmpty(source.rows).map(rowText)).concat([
          stack('horizontal', 8, [actionButton(objectOrEmpty(source.cancel)), actionButton(objectOrEmpty(source.confirm))], { wrap: true })
        ]), { border: '#cc4b4b' });
      case 'outcome':
        return box([
          sectionTitle(source.title),
          source.detail ? text(source.detail, 12, 'regular', 'darkTextSecondary', 3) : null
        ]);
      case 'problemList':
        return box(arrayOrEmpty(source.problems).map(function (problem) {
          var row = objectOrEmpty(problem);
          return stack('vertical', 3, [
            text(row.title, 13, 'semibold', 'darkTextPrimary', 2),
            row.detail ? text(row.detail, 11, 'regular', 'darkTextSecondary', 2) : null
          ]);
        }), { border: '#9a6b18' });
      case 'loading':
        return box([sectionTitle(source.title)]);
      case 'error':
        return box([
          sectionTitle(source.title),
          source.detail ? text(source.detail, 12, 'regular', 'darkTextSecondary', 3) : null,
          source.retry ? actionButton(objectOrEmpty(source.retry)) : null
        ], { border: '#cc4b4b' });
      case 'empty':
      default:
        return box([
          sectionTitle(source.title),
          source.explanation ? text(source.explanation, 12, 'regular', 'darkTextSecondary', 3) : null
        ]);
    }
  }

  function normalizeDescriptor(value) {
    var source = objectOrEmpty(value);
    return {
      schema: readString(source.schema, 'plan-lifecycle.surface-descriptor.v1'),
      revision: readString(source.revision),
      sections: arrayOrEmpty(source.sections)
    };
  }

  function coverage(descriptor) {
    var kinds = descriptor.sections.map(function (section) {
      return readString(objectOrEmpty(section).kind, 'empty');
    });
    var actionIds = [];
    for (var i = 0; i < descriptor.sections.length; i += 1) {
      var section = objectOrEmpty(descriptor.sections[i]);
      var actions = [];
      if (section.kind === 'actionRail') actions = arrayOrEmpty(section.actions);
      if (section.kind === 'confirmation') actions = [section.confirm, section.cancel];
      if (section.kind === 'error' && section.retry) actions = [section.retry];
      for (var j = 0; j < actions.length; j += 1) {
        var id = readString(objectOrEmpty(actions[j]).id);
        if (id) actionIds.push(id);
      }
    }
    return {
      section_count: descriptor.sections.length,
      section_kinds: kinds,
      section_kind_contract: SECTION_KIND_CONTRACT.slice(),
      action_ids: actionIds,
      revision: descriptor.revision
    };
  }

  function renderDescriptorNativeSnapshot(descriptorInput, lifecycleKey) {
    var descriptor = normalizeDescriptor(descriptorInput);
    return {
      schema: 'bitfield.native.view.snapshot',
      descriptor_schema: descriptor.schema,
      lifecycle_key: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
      coverage: coverage(descriptor),
      root: node('screen', {
        lifecycleKey: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
        background: 'darkCanvas',
        minHeight: 900
      }, [
        stack('vertical', 12, descriptor.sections.map(renderSection), { padding: 16, maxWidth: 720 })
      ])
    };
  }

  function mountDescriptor(record, bridge) {
    var source = objectOrEmpty(record);
    var props = objectOrEmpty(source.props);
    var lifecycleKey = readString(source.lifecycle_key || props.lifecycle_key, DEFAULT_LIFECYCLE_KEY);
    var descriptor = props.surfaceDescriptor || props.surface_descriptor || source.surfaceDescriptor || source.surface_descriptor || props.descriptor || source.descriptor;
    var snapshot = renderDescriptorNativeSnapshot(descriptor, lifecycleKey);
    bridge.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    return {
      dispose: function () {
        bridge.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycleKey }));
      }
    };
  }

  globalThis.PlanLifecycleJscore = {
    renderDescriptorNativeSnapshot: renderDescriptorNativeSnapshot,
    mountDescriptor: mountDescriptor,
    sectionKindContract: SECTION_KIND_CONTRACT.slice()
  };
  globalThis.bitfieldMount = mountDescriptor;
  globalThis.putThingOnScreen = mountDescriptor;
}());
