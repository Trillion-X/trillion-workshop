(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var DEFAULT_LIFECYCLE_KEY = 'component:stripe-payment-provider:jscore';
  var CATEGORY_ORDER = ['summary', 'review', 'readiness', 'timeline', 'proof', 'action', 'empty', 'error'];
  var TONE_COLORS = {
    neutral: { background: 'darkSurfaceRaised', border: 'darkBorder', text: 'darkTextSecondary' },
    info: { background: '#12315a', border: 'accent', text: 'accent' },
    success: { background: '#10351f', border: '#2aa15f', text: '#6fdc99' },
    warning: { background: '#493715', border: '#9a6b18', text: '#f0c36a' },
    error: { background: '#3a1717', border: '#cc4b4b', text: '#ff8f8f' }
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

  function toneStyle(status) {
    var tone = readString(objectOrEmpty(status).tone, 'neutral');
    return TONE_COLORS[tone] || TONE_COLORS.neutral;
  }

  function badge(status) {
    var row = objectOrEmpty(status);
    var style = toneStyle(row);
    return box([text(readString(row.label, 'Not started'), 11, 'semibold', style.text, 1)], {
      background: style.background,
      border: style.border,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    });
  }

  function mark(spec, status) {
    var source = objectOrEmpty(spec);
    var label = readString(source.name || objectOrEmpty(status).label, 'Status');
    var monogram = readString(source.monogram, label.charAt(0).toUpperCase() || 'S');
    var style = toneStyle(status);
    return box([text(monogram, 12, 'bold', style.text, 1)], {
      background: style.background,
      border: style.border,
      borderWidth: 1,
      cornerRadius: 10,
      padding: 9,
      fillWidth: false,
      accessibilityLabel: label,
      glyph: readString(source.glyph)
    });
  }

  function actionPress(action) {
    var row = objectOrEmpty(action);
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: readString(row.target, 'slot::workflow'),
        payload: {
          action: {
            id: readString(row.id),
            label: readString(row.label),
            enabled: row.enabled !== false
          },
          input: objectOrEmpty(row.payload)
        }
      }
    };
  }

  function actionButton(part) {
    var action = objectOrEmpty(part.action);
    var enabled = action.enabled !== false;
    return box([text(readString(action.label || part.label, 'Action'), 12, 'semibold', enabled ? 'accent' : 'darkTextSecondary', 1)], {
      background: enabled ? '#12315a' : 'darkSurfaceRaised',
      border: enabled ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      press: enabled ? actionPress(action) : null,
      disabledReason: readString(action.disabledReason || action.disabled_reason)
    });
  }

  function partRow(part) {
    var children = [];
    if (part.mark || part.status) children.push(mark(part.mark, part.status));
    children.push(stack('vertical', 3, [
      text(part.label, part.emphasis === 'strong' ? 15 : 13, part.emphasis === 'strong' ? 'bold' : 'semibold', 'darkTextPrimary', 2),
      part.value ? text(part.value, 12, 'regular', 'darkTextSecondary', 2) : null,
      part.copy ? text(part.copy, 12, 'regular', 'darkTextSecondary', 3) : null
    ]));
    if (part.status) children.push(badge(part.status));
    return stack('horizontal', 10, children, { align: 'center' });
  }

  function sectionTitle(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  function renderSection(section) {
    var category = readString(section.category, 'empty');
    var parts = arrayOrEmpty(section.parts).map(objectOrEmpty);
    switch (category) {
      case 'summary':
        return box(parts.map(partRow), { background: 'darkSurface' });
      case 'review':
      case 'readiness':
      case 'timeline':
      case 'proof':
        return box([text(sectionTitle(category), 13, 'bold', 'darkTextPrimary', 1)].concat(parts.map(partRow)), {});
      case 'action':
        return stack('horizontal', 8, parts.map(actionButton), { horizontalScroll: true });
      case 'empty':
        return box(parts.map(partRow), { background: 'darkSurface' });
      case 'error':
        return box(parts.map(partRow), { background: '#241313', border: '#cc4b4b' });
      default:
        return box(parts.map(partRow), {});
    }
  }

  function normalizeDescriptor(value) {
    var source = objectOrEmpty(value);
    return {
      schema: readString(source.schema, 'stripe-payment-provider.surface-descriptor.v1'),
      sections: arrayOrEmpty(source.sections).map(function (section) {
        var row = objectOrEmpty(section);
        return { category: readString(row.category, 'empty'), parts: arrayOrEmpty(row.parts) };
      }),
      evidence_projection_id: readString(source.evidence_projection_id),
      invocation_id: readString(source.invocation_id),
      receipt_id: readString(source.receipt_id)
    };
  }

  function coverage(descriptor) {
    var categories = descriptor.sections.map(function (section) { return section.category; });
    var actionIds = [];
    var partCount = 0;
    for (var i = 0; i < descriptor.sections.length; i += 1) {
      var parts = arrayOrEmpty(descriptor.sections[i].parts);
      partCount += parts.length;
      for (var j = 0; j < parts.length; j += 1) {
        var action = objectOrEmpty(objectOrEmpty(parts[j]).action);
        var actionId = readString(action.id);
        if (actionId) actionIds.push(actionId);
      }
    }
    return {
      section_count: descriptor.sections.length,
      part_count: partCount,
      categories: categories,
      category_contract: CATEGORY_ORDER,
      action_ids: actionIds,
      evidence_projection_id: descriptor.evidence_projection_id,
      invocation_id: descriptor.invocation_id,
      receipt_id: descriptor.receipt_id
    };
  }

  function renderDescriptorNativeSnapshot(descriptorInput, lifecycleKey) {
    var descriptor = normalizeDescriptor(descriptorInput);
    var categories = descriptor.sections.map(function (section) { return section.category; });
    var root = node('screen', {
      lifecycleKey: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
      background: 'darkCanvas'
    }, [
      stack('vertical', 12, descriptor.sections.map(renderSection), {
        padding: 16,
        maxWidth: 720
      })
    ]);
    return {
      schema: 'bitfield.native.view.snapshot',
      descriptor_schema: descriptor.schema,
      lifecycle_key: readString(lifecycleKey, DEFAULT_LIFECYCLE_KEY),
      coverage: coverage(descriptor),
      root: root,
      metadata: { drew_categories: categories }
    };
  }

  function mountDescriptor(mountRecord, bridge) {
    var source = objectOrEmpty(mountRecord);
    var props = objectOrEmpty(source.props);
    var lifecycleKey = readString(source.lifecycle_key || props.lifecycle_key, DEFAULT_LIFECYCLE_KEY);
    var descriptor = normalizeDescriptor(props.descriptor || source.descriptor);
    var snapshot = renderDescriptorNativeSnapshot(descriptor, lifecycleKey);
    bridge.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    if (typeof console !== 'undefined' && console.info) {
      console.info('[stripe-provider/ios] drew categories=' + snapshot.coverage.categories.join(','));
    }
    return {
      dispose: function () {
        bridge.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycleKey }));
      }
    };
  }

  globalThis.StripePaymentProviderJscore = {
    renderDescriptorNativeSnapshot: renderDescriptorNativeSnapshot,
    mountDescriptor: mountDescriptor,
    categoryContract: CATEGORY_ORDER.slice()
  };
  globalThis.bitfieldMount = mountDescriptor;
  globalThis.putThingOnScreen = mountDescriptor;
}());
