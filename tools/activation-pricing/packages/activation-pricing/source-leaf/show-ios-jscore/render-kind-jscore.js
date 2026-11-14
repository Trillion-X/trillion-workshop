(function () {
  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function text(value, role) {
    return {
      id: 'text:' + role + ':' + String(value || '').slice(0, 32),
      kind: 'text',
      props: {
        role: role || 'body',
        text: String(value || ''),
        size: role === 'title' ? 28 : role === 'summary' ? 16 : 14,
        weight: role === 'title' ? 'heavy' : role === 'label' ? 'semibold' : 'regular',
        color: role === 'status' || role === 'metadata' ? 'darkTextSecondary' : 'darkTextPrimary'
      },
      children: []
    };
  }

  function sectionNode(section, children) {
    return {
      id: String(section.id || ''),
      kind: 'stack',
      props: {
        role: String(section.kind || ''),
        layoutHint: section.layoutHint ? String(section.layoutHint) : 'stack',
        spacing: 10,
        padding: 12
      },
      children: arrayOrEmpty(children)
    };
  }

  function renderHeader(section) {
    var payload = objectOrEmpty(section.payload);
    var children = [text(payload.title, 'title')];
    if (payload.summary) children.push(text(payload.summary, 'summary'));
    if (payload.status) children.push(text(payload.status, 'status'));
    if (payload.freshnessLabel) children.push(text(payload.freshnessLabel, 'metadata'));
    return sectionNode(section, children);
  }

  function renderNotice(section) {
    var payload = objectOrEmpty(section.payload);
    return {
      id: String(section.id || ''),
      kind: 'stack',
      props: {
        role: 'notice',
        tone: String(payload.tone || 'info'),
        layoutHint: section.layoutHint ? String(section.layoutHint) : 'stack',
        spacing: 8,
        padding: 12
      },
      children: [text(payload.label, 'body')]
    };
  }

  function renderChoiceSection(section) {
    var payload = objectOrEmpty(section.payload);
    return sectionNode(section, [
      text(payload.label, 'label'),
      {
        id: String(section.id || '') + ':choices',
        kind: 'choice-group',
        props: {
          selectedId: payload.selectedId ? String(payload.selectedId) : null,
          choices: arrayOrEmpty(payload.choices).map(function (choice) {
            return {
              id: String(choice.id || ''),
              label: String(choice.label || ''),
              disabled: Boolean(choice.disabled)
            };
          })
        },
        children: []
      }
    ]);
  }

  function renderVariableSection(section) {
    var payload = objectOrEmpty(section.payload);
    return sectionNode(section, [
      {
        id: String(section.id || '') + ':control',
        kind: 'number-control',
        props: {
          label: String(payload.label || ''),
          value: typeof payload.value === 'number' ? payload.value : 0,
          min: typeof payload.min === 'number' ? payload.min : null,
          max: typeof payload.max === 'number' ? payload.max : null,
          step: typeof payload.step === 'number' ? payload.step : null,
          help: payload.help ? String(payload.help) : null
        },
        children: []
      }
    ]);
  }

  function renderOptions(section) {
    var payload = objectOrEmpty(section.payload);
    return sectionNode(
      section,
      arrayOrEmpty(payload.options).map(function (option) {
        return {
          id: String(option.id || ''),
          kind: 'stack',
          props: {
            role: 'option-card',
            title: String(option.title || ''),
            summary: option.summary ? String(option.summary) : '',
            emphasized: Boolean(option.emphasis),
            spacing: 8,
            padding: 12
          },
          children: [
            text(option.title, 'title'),
            option.summary ? text(option.summary, 'summary') : null
          ].filter(Boolean).concat(arrayOrEmpty(option.fields).map(function (field) {
            return {
              id: String(option.id || '') + ':' + String(field.id || ''),
              kind: 'text',
              props: {
                role: 'field',
                text: String(field.label || '') + ': ' + String(field.formatted || ''),
                size: 14,
                weight: 'regular',
                color: 'darkTextPrimary'
              },
              children: []
            };
          }))
        };
      })
    );
  }

  function renderDetails(section) {
    var payload = objectOrEmpty(section.payload);
    return sectionNode(
      section,
      arrayOrEmpty(payload.rows).map(function (row) {
        return {
          id: String(row.id || ''),
          kind: 'text',
          props: {
            role: 'detail-row',
            text: String(row.label || '') + ': ' + String(row.value || ''),
            size: 14,
            weight: 'regular',
            color: 'darkTextSecondary'
          },
          children: []
        };
      })
    );
  }

  function renderActions(section) {
    var payload = objectOrEmpty(section.payload);
    return sectionNode(
      section,
      arrayOrEmpty(payload.actions).map(function (action) {
        return {
          id: String(action.id || ''),
          kind: 'box',
          props: {
            role: 'action',
            label: String(action.label || ''),
            disabled: !action.enabled,
            disabledReason: action.disabledReason ? String(action.disabledReason) : null,
            background: action.enabled ? 'darkControlBackground' : 'darkElevatedBackground',
            cornerRadius: 8,
            padding: 12,
            press: action.enabled ? {
              operation: 'runtime.target.invoke',
              payload: {
                targetRef: objectOrEmpty(action.targetRef)
              }
            } : null
          },
          children: [text(action.enabled ? action.label : (action.disabledReason || action.label), 'label')]
        };
      })
    );
  }

  function renderDiagnostics(section) {
    var payload = objectOrEmpty(section.payload);
    var counts = objectOrEmpty(payload.counts);
    return sectionNode(section, [
      {
        id: String(section.id || '') + ':reference',
        kind: 'diagnostic-ref',
        props: {
          reference: String(payload.reference || ''),
          counts: {
            records: Number(counts.records || 0),
            actions: Number(counts.actions || 0),
            fields: Number(counts.fields || 0)
          }
        },
        children: []
      }
    ]);
  }

  function renderKindForJscore(section) {
    switch (section && section.kind) {
      case 'header':
        return renderHeader(section);
      case 'notice':
        return renderNotice(section);
      case 'dimension-selector':
        return renderChoiceSection(section);
      case 'variable-control':
        return renderVariableSection(section);
      case 'option-comparison':
        return renderOptions(section);
      case 'detail-rows':
        return renderDetails(section);
      case 'action':
        return renderActions(section);
      case 'diagnostics':
        return renderDiagnostics(section);
      default:
        throw new Error('Unsupported section kind');
    }
  }

  globalThis.ActivationPricingJscoreRenderKind = {
    renderKindForJscore: renderKindForJscore
  };
})();
