(function () {
  var PACKAGE_NAME = 'bitfield-package-store-offer-exchange';
  var INPUT_NAME = 'offer-setup-surface-descriptor';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var ACTION_REQUEST_OPERATION = 'record-exchange.action.request';

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
    var built = {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean)
    };
    if (id) built.id = id;
    return built;
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

  function toneTokens(tone) {
    var key = readString(tone, 'neutral').toLowerCase();
    var colors = {
      neutral: { background: 'darkSurfaceRaised', border: 'darkBorder', text: 'darkTextSecondary' },
      success: { background: '#0f2d22', border: '#2fbf71', text: '#8fe7b9' },
      warning: { background: '#33270f', border: '#d6a12a', text: '#ffd98a' },
      error: { background: '#351817', border: '#e05a4f', text: '#ffaaa3' },
      primary: { background: '#12315a', border: 'accent', text: 'accent' },
      destructive: { background: '#351817', border: '#e05a4f', text: '#ffaaa3' },
      quiet: { background: 'darkSurface', border: 'darkBorder', text: 'darkTextSecondary' }
    };
    return colors[key] || colors.neutral;
  }

  function badge(label, tone) {
    var colors = toneTokens(tone);
    return box({
      background: colors.background,
      border: colors.border,
      borderWidth: 1,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    }, [text(label, 11, 'semibold', colors.text, 1)]);
  }

  function keyValueRows(rows) {
    return arrayOrEmpty(rows).map(function (row, index) {
      var item = objectOrEmpty(row);
      var label = readString(item.label);
      var value = readString(item.value, '');
      return text(label + (value ? ': ' + value : ''), 12, 'regular', toneTokens(item.tone).text, 2);
    });
  }

  function actionPress(action) {
    if (!readBoolean(action.enabled, false)) return null;
    return {
      operation: ACTION_REQUEST_OPERATION,
      body: {
        action_id: readString(action.id),
        action_descriptor: action
      }
    };
  }

  function actionButton(actionValue, primary) {
    var action = objectOrEmpty(actionValue);
    var enabled = readBoolean(action.enabled, false);
    var colors = toneTokens(enabled ? (primary ? 'primary' : action.intent) : 'neutral');
    var press = actionPress(action);
    return box({
      background: colors.background,
      border: colors.border,
      borderWidth: 1,
      cornerRadius: 14,
      padding: 12,
      fillWidth: true,
      disabled: !enabled,
      press: press || undefined
    }, [
      text(readString(action.label), 13, 'semibold', enabled ? colors.text : 'darkTextSecondary', 1),
      !enabled && action.disabledReason ? text(action.disabledReason, 11, 'regular', 'darkTextSecondary', 2) : null
    ]);
  }

  function renderHeader(section) {
    var freshness = objectOrEmpty(section.freshness);
    return stack('vertical', 8, [
      text(section.title, 30, 'bold', 'darkTextPrimary', 2),
      section.explanation ? text(section.explanation, 13, 'regular', 'darkTextSecondary', 3) : null,
      freshness.label ? badge(freshness.label, freshness.tone) : null
    ]);
  }

  function renderSummaryStrip(section) {
    return stack('horizontal', 8, arrayOrEmpty(section.stats).map(function (stat) {
      var item = objectOrEmpty(stat);
      return box({ background: 'darkSurfaceRaised', border: 'darkBorder', borderWidth: 1, cornerRadius: 14, padding: 11, fillWidth: true }, [
        text(item.value, 20, 'bold', 'darkTextPrimary', 1),
        text(item.label, 11, 'regular', 'darkTextSecondary', 1)
      ], item.id);
    }), { wrap: true });
  }

  function renderOfferSummary(section) {
    return box({ background: 'darkSurfaceRaised', border: toneTokens(section.statusTone).border, borderWidth: 1, cornerRadius: 18, padding: 14, spacing: 9 }, [
      stack('horizontal', 8, [
        text(section.title, 18, 'bold', 'darkTextPrimary', 2),
        badge(section.statusLabel, section.statusTone)
      ]),
      stack('vertical', 5, keyValueRows(section.lines))
    ]);
  }

  function renderTermsList(section) {
    return box({ background: 'darkSurface', border: 'darkBorder', borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 7 }, [
      section.title ? text(section.title, 14, 'bold', 'darkTextPrimary', 1) : null,
      stack('vertical', 6, arrayOrEmpty(section.items).map(function (itemValue) {
        var item = objectOrEmpty(itemValue);
        return text(readString(item.label) + (item.value ? ': ' + readString(item.value) : ''), 12, 'regular', toneTokens(item.tone).text, 2);
      }))
    ]);
  }

  function renderChecklist(section) {
    return box({ background: 'darkSurface', border: 'darkBorder', borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 8 }, [
      section.title ? text(section.title, 14, 'bold', 'darkTextPrimary', 1) : null,
      stack('vertical', 7, arrayOrEmpty(section.items).map(function (itemValue) {
        var item = objectOrEmpty(itemValue);
        return stack('horizontal', 8, [
          item.stateLabel ? badge(readString(item.stateLabel), item.stateTone) : null,
          stack('vertical', 3, [
            text(item.label, 12, 'semibold', 'darkTextPrimary', 2),
            item.detail ? text(item.detail, 11, 'regular', 'darkTextSecondary', 2) : null
          ])
        ]);
      }))
    ]);
  }

  function renderProblemList(section) {
    return box({ background: '#33270f', border: '#d6a12a', borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 7 }, [
      section.title ? text(section.title, 14, 'bold', '#ffd98a', 1) : null,
      stack('vertical', 6, arrayOrEmpty(section.problems).map(function (problemValue) {
        var problem = objectOrEmpty(problemValue);
        return stack('vertical', 2, [
          text(problem.title, 12, 'semibold', '#ffd98a', 2),
          problem.detail ? text(problem.detail, 11, 'regular', 'darkTextSecondary', 2) : null
        ]);
      }))
    ]);
  }

  function renderReviewCommit(section) {
    var actions = [section.primaryAction].concat(arrayOrEmpty(section.secondaryActions));
    return box({ background: 'darkSurfaceRaised', border: 'accent', borderWidth: 1, cornerRadius: 18, padding: 14, spacing: 9, position: 'bottomAction' }, [
      section.title ? text(section.title, 14, 'bold', 'darkTextPrimary', 1) : null,
      stack('vertical', 4, keyValueRows(section.summaryRows).slice(0, 4)),
      stack('vertical', 8, actions.map(function (action, index) { return actionButton(action, index === 0); }))
    ]);
  }

  function renderActionOutcome(section) {
    var colors = toneTokens(section.tone);
    return box({ background: colors.background, border: colors.border, borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 5 }, [
      text(section.title, 14, 'bold', colors.text, 2),
      section.detail ? text(section.detail, 12, 'regular', 'darkTextSecondary', 3) : null
    ]);
  }

  function renderProofDisclosure(section) {
    return box({ background: 'darkSurface', border: 'darkBorder', borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 7, presentation: 'sheet' }, [
      text(section.summaryLabel, 14, 'bold', 'darkTextPrimary', 1),
      stack('vertical', 5, arrayOrEmpty(section.rows).map(function (rowValue) {
        var row = objectOrEmpty(rowValue);
        return text(readString(row.label) + (row.value ? ': ' + readString(row.value) : ''), 11, 'regular', 'darkTextSecondary', 2);
      }))
    ]);
  }

  function renderEmpty(section) {
    return box({ background: 'darkSurfaceRaised', border: 'darkBorder', borderWidth: 1, cornerRadius: 18, padding: 18, spacing: 8 }, [
      text(section.title, 18, 'bold', 'darkTextPrimary', 2),
      section.explanation ? text(section.explanation, 12, 'regular', 'darkTextSecondary', 3) : null,
      section.primaryAction ? actionButton(section.primaryAction, true) : null
    ]);
  }

  function renderSimple(section, tone) {
    var colors = toneTokens(tone);
    return box({ background: colors.background, border: colors.border, borderWidth: 1, cornerRadius: 16, padding: 13, spacing: 5 }, [
      text(section.title, 14, 'bold', colors.text, 2),
      section.detail ? text(section.detail, 12, 'regular', 'darkTextSecondary', 3) : null,
      section.retry ? actionButton(section.retry, false) : null
    ]);
  }

  function renderSection(sectionValue) {
    var section = objectOrEmpty(sectionValue);
    switch (section.kind) {
      case 'header':
        return renderHeader(section);
      case 'summaryStrip':
        return renderSummaryStrip(section);
      case 'offerSummary':
        return renderOfferSummary(section);
      case 'termsList':
        return renderTermsList(section);
      case 'checklist':
        return renderChecklist(section);
      case 'problemList':
        return renderProblemList(section);
      case 'reviewCommit':
        return renderReviewCommit(section);
      case 'actionOutcome':
        return renderActionOutcome(section);
      case 'proofDisclosure':
        return renderProofDisclosure(section);
      case 'empty':
        return renderEmpty(section);
      case 'loading':
        return renderSimple(section, 'neutral');
      case 'error':
        return renderSimple(section, 'error');
      default:
        return null;
    }
  }

  function normalizeDescriptor(input) {
    var descriptor = objectOrEmpty(input);
    return { sections: arrayOrEmpty(descriptor.sections) };
  }

  function buildSnapshot(key, descriptorInput) {
    var descriptor = normalizeDescriptor(descriptorInput);
    var proofRows = descriptor.sections.reduce(function (count, section) {
      return count + arrayOrEmpty(objectOrEmpty(section).rows).length;
    }, 0);
    var actionCount = descriptor.sections.reduce(function (count, section) {
      var next = objectOrEmpty(section);
      return count + (next.primaryAction ? 1 : 0) + arrayOrEmpty(next.secondaryActions).length;
    }, 0);
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      summary: {
        renderer: 'bitfield-package-store-offer-exchange-jscore',
        section_count: descriptor.sections.length,
        action_count: actionCount,
        proof_row_count: proofRows
      },
      root: node('screen', { background: 'darkBackground', minHeight: 900, safeArea: true, padding: 20, spacing: 14 }, [
        stack('vertical', 12, descriptor.sections.map(renderSection), { role: 'touch-first-stepper' })
      ])
    };
  }

  function readPackageInput(mount) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
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

  function mountSurface(record, mount) {
    var source = objectOrEmpty(record);
    var props = objectOrEmpty(source.props);
    var key = readString(source.lifecycle_key, 'component:bitfield-package-store-offer-exchange:jscore');
    var descriptor = props.surfaceDescriptor || props.surface_descriptor || props.descriptor || readPackageInput(mount) || { sections: [] };
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(key, descriptor)));
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.BitfieldPackageStoreOfferExchangeJscore = {
    buildSnapshot: buildSnapshot,
    normalizeDescriptor: normalizeDescriptor,
    renderSection: renderSection
  };
  globalThis.bitfieldMount = mountSurface;
  globalThis.putThingOnScreen = mountSurface;
}());
