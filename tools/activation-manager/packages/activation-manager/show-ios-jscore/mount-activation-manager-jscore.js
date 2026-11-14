// Purpose: JavaScriptCore realization entry for activation-manager.
// Invariants: no web framework, DOM, browser storage, or platform backend policy. The
// mount consumes the same package projection shape as the browser surface and
// emits sealed native screen snapshot operations.

(function () {
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var PACKAGE_NAME = 'activation-manager';
  var INPUT_NAME = 'activation-state';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : (fallback || '');
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean)
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
      color: color || 'darkTextPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function toneColor(tone) {
    var key = readString(tone, 'neutral').toLowerCase();
    var colors = {
      neutral: { background: 'darkSurfaceRaised', border: 'darkBorder', text: 'darkTextSecondary' },
      info: { background: '#102844', border: '#2f80ed', text: '#8fc7ff' },
      success: { background: '#0f2d22', border: '#2fbf71', text: '#8fe7b9' },
      warning: { background: '#33270f', border: '#d6a12a', text: '#ffd98a' },
      error: { background: '#351817', border: '#e05a4f', text: '#ffaaa3' },
      primary: { background: '#12315a', border: 'accent', text: 'accent' },
      danger: { background: '#351817', border: '#e05a4f', text: '#ffaaa3' }
    };
    return colors[key] || colors.neutral;
  }

  function badge(label, tone) {
    var colors = toneColor(tone);
    return box({
      background: colors.background,
      border: colors.border,
      borderWidth: 1,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    }, [text(label, 11, 'semibold', colors.text, 1)]);
  }

  function humanizeRaw(value) {
    var words = readString(value, 'not-started').replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function statusView(row) {
    var supplied = objectOrEmpty(row.statusView || row.status_view);
    var state = objectOrEmpty(row.state || row.stateDescriptor || row.state_descriptor);
    var label = readString(supplied.label, '');
    if (!label) label = readString(state.label, '');
    if (label) {
      return {
        label: label,
        tone: readString(supplied.tone || state.tone, 'neutral'),
        isTerminal: readBoolean(supplied.isTerminal, readBoolean(supplied.is_terminal, readBoolean(state.terminal, false))),
        isError: readBoolean(supplied.isError, readBoolean(supplied.is_error, readBoolean(state.error, false)))
      };
    }
    return {
      label: humanizeRaw(row.statusRaw || row.status_raw || row.status || row.state_key || state.key || row.state),
      tone: readString(supplied.tone || state.tone, 'neutral'),
      isTerminal: false,
      isError: false
    };
  }

  function lifecycleKey(record) {
    return readString(objectOrEmpty(record).lifecycle_key, 'component:activation-manager:jscore');
  }

  function readPackageInput(mount) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: INPUT_NAME
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function actionDescriptor(value, index) {
    var source = objectOrEmpty(value);
    var enabled = source.enabled;
    if (enabled === undefined && source.disabled !== undefined) enabled = !Boolean(source.disabled);
    return {
      id: readString(source.id || source.key || source.ref, 'action:' + String(index)),
      label: readString(source.label || source.title, 'Review'),
      tone: readString(source.tone || source.displayRole || source.display_role, 'neutral'),
      enabled: readBoolean(enabled, true),
      disabledReason: readString(source.disabledReason || source.disabled_reason, ''),
      target: readString(source.target || source.targetRef || source.target_ref, ''),
      operation: readString(source.operation || source.method, ''),
      input: objectOrEmpty(source.input || source.request || source.payload),
      raw: source
    };
  }

  function proofRow(value, index) {
    var source = objectOrEmpty(value);
    return {
      id: readString(source.id || source.ref, 'proof:' + String(index)),
      label: readString(source.label || source.title || source.kindLabel || source.kind_label, 'Proof'),
      detail: readString(source.detail || source.dateLabel || source.date_label || source.originLabel || source.origin_label, '')
    };
  }

  function activationRow(value, index) {
    var source = objectOrEmpty(value);
    var id = readString(source.activationId || source.activation_id || source.id || source.ref, 'activation:' + String(index));
    var view = statusView(source);
    var evidenceRefs = arrayOrEmpty(source.evidenceRefs || source.evidence_refs).map(function (entry, evidenceIndex) {
      return { id: 'evidence:' + String(evidenceIndex), label: 'Proof', detail: readString(entry, '') };
    });
    return {
      id: id,
      title: readString(source.label || source.title || source.name, 'Package access'),
      subtitle: readString(source.summary || source.detail || source.statusCopy || source.status_copy, ''),
      statusView: view,
      capabilityRef: readString(source.capabilityRef || source.capability_ref, ''),
      subjectRef: readString(source.subjectRef || source.subject_ref, ''),
      actions: arrayOrEmpty(source.nextActions || source.next_actions || source.nextActionDescriptors || source.next_action_descriptors || source.actions || source.actionDescriptors || source.action_descriptors).map(actionDescriptor),
      proofRows: arrayOrEmpty(source.proofRows || source.proof_rows || source.evidenceRows || source.evidence_rows).map(proofRow).concat(evidenceRefs),
      raw: source
    };
  }

  function readModel(input) {
    var source = objectOrEmpty(input);
    var rows = arrayOrEmpty(source.views || source.activationRows || source.activation_rows || source.activations || source.rows || source.items).map(activationRow);
    return {
      title: readString(source.title || source.label || objectOrEmpty(source.projection).label, 'Package activation'),
      subtitle: readString(source.subtitle || source.summary, 'Review package readiness and the next available action.'),
      rows: rows
    };
  }

  function actionPress(row, action) {
    if (!action.enabled || !action.target) return null;
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: action.target,
        payload: {
          operation: action.operation || action.id,
          action_descriptor: action.raw,
          activation_id: row.id,
          capability_ref: row.capabilityRef || undefined,
          subject_ref: row.subjectRef || undefined,
          input: action.input
        }
      }
    };
  }

  function actionButton(row, action) {
    var press = actionPress(row, action);
    var tone = action.enabled ? action.tone : 'neutral';
    var colors = toneColor(tone);
    return box({
      background: colors.background,
      border: colors.border,
      borderWidth: 1,
      cornerRadius: 12,
      padding: 10,
      fillWidth: false,
      press: press || undefined
    }, [
      text(action.label, 12, 'semibold', action.enabled ? colors.text : 'darkTextSecondary', 1),
      !action.enabled && action.disabledReason ? text(action.disabledReason, 10, 'regular', 'darkTextSecondary', 2) : null
    ]);
  }

  function activationCard(row) {
    var actions = [];
    for (var i = 0; i < row.actions.length && i < 3; i += 1) actions.push(actionButton(row, row.actions[i]));
    var proof = [];
    for (var j = 0; j < row.proofRows.length && j < 3; j += 1) {
      proof.push(text(row.proofRows[j].label + (row.proofRows[j].detail ? ': ' + row.proofRows[j].detail : ''), 11, 'regular', 'darkTextSecondary', 2));
    }
    return box({
      background: row.statusView.isError ? '#2c1718' : 'darkSurfaceRaised',
      border: toneColor(row.statusView.tone).border,
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 9
    }, [
      stack('horizontal', 8, [
        text(row.title, 17, 'bold', 'darkTextPrimary', 2),
        badge(row.statusView.label, row.statusView.tone)
      ]),
      row.subtitle ? text(row.subtitle, 12, 'regular', 'darkTextSecondary', 3) : null,
      proof.length ? stack('vertical', 4, proof) : null,
      actions.length ? stack('horizontal', 7, actions) : null
    ]);
  }

  function buildSnapshot(key, model) {
    var children = [
      text(model.title, 30, 'bold', 'darkTextPrimary', 2),
      model.subtitle ? text(model.subtitle, 13, 'regular', 'darkTextSecondary', 3) : null
    ];
    if (!model.rows.length) {
      children.push(box({
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 18,
        spacing: 8
      }, [
        text('No packages need activation yet.', 17, 'semibold', 'darkTextPrimary', 2),
        text('When package access needs attention, it appears here with the next available action.', 12, 'regular', 'darkTextSecondary', 3)
      ]));
    } else {
      var cards = [];
      for (var i = 0; i < model.rows.length && i < 10; i += 1) cards.push(activationCard(model.rows[i]));
      children.push(stack('vertical', 10, cards));
    }
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 16
      }, children)
    };
  }

  function mountSurface(record, mount) {
    var key = lifecycleKey(record);
    try {
      var props = objectOrEmpty(objectOrEmpty(record).props);
      var input = props.activationState || props.activation_state || readPackageInput(mount) || {};
      var model = readModel(input);
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(key, model)));
    } catch (error) {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify({
        schema: 'bitfield.native.view.snapshot',
        lifecycle_key: key,
        root: node('screen', {
          background: 'darkBackground',
          cornerRadius: 0,
          minHeight: 900,
          padding: 24,
          spacing: 12
        }, [
          text('Activation screen unavailable', 24, 'bold', 'darkTextPrimary', 2),
          text('Try again from the package screen.', 13, 'regular', '#ffaaa3', 4)
        ])
      }));
    }
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.bitfieldMount = mountSurface;
  globalThis.putThingOnScreen = mountSurface;
  globalThis.__activationManagerJscoreConformance = {
    readModel: readModel,
    buildSnapshot: buildSnapshot
  };
}());
