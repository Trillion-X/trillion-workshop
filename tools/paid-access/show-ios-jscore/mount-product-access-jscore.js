// package-set://bitfield-studio/packages/product-access/show-ios-jscore/mount-product-access-jscore.js
//
// JavaScriptCore realization entry for product-access. The native shell receives
// sealed view snapshots and target-invoke payloads; this file renders only the
// descriptor's closed section categories and copies all human/status/action data.

(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var PACKAGE_NAME = 'product-access';
  var DESCRIPTOR_INPUT_NAME = 'surface-descriptor';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : (fallback || '');
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean),
    };
  }

  function stack(axis, spacing, children, props) {
    var merged = objectOrEmpty(props);
    merged.axis = axis || 'vertical';
    merged.spacing = spacing || 0;
    return node('stack', merged, children);
  }

  function box(props, children) {
    return node('box', props, children);
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value || ''),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary',
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function badge(label, tone) {
    return box({
      background: tone ? 'darkSurfaceRaised' : 'darkSurface',
      border: tone || 'darkBorder',
      borderWidth: 1,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false,
    }, [text(label, 11, 'semibold', tone || 'darkTextSecondary', 1)]);
  }

  function actionPress(action) {
    if (!action || action.enabled !== true) return null;
    var ownerAction = objectOrEmpty(action.ownerAction);
    var target = readString(ownerAction.target, '');
    if (!target) return null;
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: target,
        payload: {
          action_id: readString(action.id, ''),
          action_descriptor: ownerAction,
          request: ownerAction.request,
        },
      },
    };
  }

  function actionButton(action) {
    var press = actionPress(action);
    var isPrimary = action && action.intent === 'primary';
    var props = {
      background: isPrimary ? '#12315a' : 'darkSurfaceRaised',
      border: isPrimary ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 10,
      fillWidth: false,
    };
    if (press) props.press = press;
    return box(props, [
      text(readString(action && action.label, 'Action'), 12, 'semibold', isPrimary ? 'accent' : 'darkTextPrimary', 1),
      action && action.enabled !== true && action.disabledReason
        ? text(action.disabledReason, 10, 'regular', 'darkTextSecondary', 2)
        : null,
    ]);
  }

  function lineRow(row) {
    var line = objectOrEmpty(row);
    return stack('horizontal', 8, [
      text(readString(line.label, ''), 11, 'regular', 'darkTextSecondary', 1),
      node('spacer', {}, []),
      text(readString(line.value, ''), 12, 'semibold', 'darkTextPrimary', 1),
    ]);
  }

  function headerSection(section) {
    return box({
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 16,
      spacing: 8,
    }, [
      stack('horizontal', 8, [
        text(readString(section.title, 'Product access'), 28, 'bold', 'darkTextPrimary', 2),
        node('spacer', {}, []),
        badge(readString(objectOrEmpty(section.freshness).label, ''), readString(objectOrEmpty(section.freshness).tone, '')),
      ]),
      section.explanation ? text(section.explanation, 13, 'regular', 'darkTextSecondary', 3) : null,
    ]);
  }

  function summarySection(section) {
    var stats = arrayOrEmpty(section.stats).map(function (stat) {
      return box({
        background: 'darkSurfaceRaised',
        border: readString(stat.tone, 'darkBorder'),
        borderWidth: 1,
        cornerRadius: 14,
        padding: 12,
        spacing: 3,
      }, [
        text(readString(stat.value, ''), 20, 'bold', 'darkTextPrimary', 1),
        text(readString(stat.label, ''), 11, 'regular', 'darkTextSecondary', 1),
      ]);
    });
    return node('grid', { columns: 3, spacing: 8 }, stats);
  }

  function itemCard(item) {
    var lines = arrayOrEmpty(item.lines).slice(0, 4).map(lineRow);
    var actions = [item.primaryAction].concat(arrayOrEmpty(item.secondaryActions)).filter(Boolean).slice(0, 3).map(actionButton);
    return box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 9,
    }, [
      stack('horizontal', 8, [
        text(readString(item.title, 'Item'), 17, 'bold', 'darkTextPrimary', 2),
        node('spacer', {}, []),
        badge(readString(item.statusLabel, ''), readString(item.statusTone, '')),
      ]),
      stack('vertical', 5, lines),
      actions.length ? stack('horizontal', 7, actions) : null,
    ]);
  }

  function itemListSection(section) {
    return stack('vertical', 10, arrayOrEmpty(section.items).map(itemCard));
  }

  function itemDetailSection(section) {
    var rows = arrayOrEmpty(section.rows).map(lineRow);
    var proof = objectOrEmpty(section.proof);
    var proofRows = arrayOrEmpty(proof.rows).map(lineRow);
    var actions = arrayOrEmpty(section.actions).map(actionButton);
    return box({
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 9,
    }, [
      text(readString(section.title, 'Detail'), 18, 'bold', 'darkTextPrimary', 2),
      stack('vertical', 5, rows),
      proofRows.length
        ? box({
            background: 'darkSurfaceRaised',
            border: 'darkBorder',
            borderWidth: 1,
            cornerRadius: 14,
            padding: 10,
            spacing: 5,
          }, [
            text(readString(proof.summaryLabel, 'Verification'), 12, 'semibold', 'darkTextPrimary', 1),
            stack('vertical', 4, proofRows),
          ])
        : null,
      actions.length ? stack('horizontal', 7, actions) : null,
    ]);
  }

  function problemListSection(section) {
    return box({
      background: 'darkSurfaceRaised',
      border: '#ff6b6b',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 12,
      spacing: 7,
    }, arrayOrEmpty(section.problems).map(function (problem) {
      return stack('vertical', 2, [
        text(readString(problem.title, 'Problem'), 13, 'semibold', 'darkTextPrimary', 2),
        problem.detail ? text(problem.detail, 11, 'regular', 'darkTextSecondary', 4) : null,
      ]);
    }));
  }

  function simpleSection(section) {
    return box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 14,
      spacing: 6,
    }, [
      text(readString(section.title, ''), 16, 'semibold', 'darkTextPrimary', 2),
      section.explanation ? text(section.explanation, 12, 'regular', 'darkTextSecondary', 4) : null,
      section.detail ? text(section.detail, 12, 'regular', 'darkTextSecondary', 4) : null,
      section.retry ? actionButton(section.retry) : null,
    ]);
  }

  function renderSection(section) {
    switch (section.kind) {
      case 'header':
        return headerSection(section);
      case 'summaryStrip':
        return summarySection(section);
      case 'itemList':
        return itemListSection(section);
      case 'itemDetail':
        return itemDetailSection(section);
      case 'problemList':
        return problemListSection(section);
      case 'actionOutcome':
      case 'empty':
      case 'loading':
      case 'error':
        return simpleSection(section);
      default:
        return null;
    }
  }

  function normalizeDescriptor(descriptor) {
    var source = objectOrEmpty(descriptor);
    return {
      schema: readString(source.schema, 'product-access.surface-descriptor.v1'),
      title: readString(source.title, 'Product access'),
      sections: arrayOrEmpty(source.sections),
    };
  }

  function buildProductAccessSnapshot(lifecycleKey, descriptor) {
    var surface = normalizeDescriptor(descriptor);
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: lifecycleKey || 'component:product-access:jscore',
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 14,
      }, surface.sections.map(renderSection)),
    };
  }

  function renderProductAccessForJscore(descriptor) {
    return buildProductAccessSnapshot('component:product-access:jscore-proof', descriptor);
  }

  function readPackageInput(mount) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: DESCRIPTOR_INPUT_NAME,
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function mountProductAccessSurface(record, mount) {
    var props = objectOrEmpty(objectOrEmpty(record).props);
    var lifecycleKey = readString(record && record.lifecycle_key, 'component:product-access:jscore');
    var descriptor = props.productAccessSurfaceDescriptor || props.descriptor || readPackageInput(mount) || {};
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildProductAccessSnapshot(lifecycleKey, descriptor)));
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycleKey }));
      },
    };
  }

  globalThis.ProductAccessJscore = {
    renderProductAccessForJscore: renderProductAccessForJscore,
    buildProductAccessSnapshot: buildProductAccessSnapshot,
    mountProductAccessSurface: mountProductAccessSurface,
  };
  globalThis.bitfieldMount = mountProductAccessSurface;
  globalThis.putThingOnScreen = mountProductAccessSurface;
}());
