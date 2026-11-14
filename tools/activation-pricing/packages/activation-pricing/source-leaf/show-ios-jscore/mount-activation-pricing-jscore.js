(function () {
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function parseJson(value, fallback) {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function parseModel(input) {
    if (typeof input === 'string') return parseJson(input, {});
    if (input && typeof input.modelBytes === 'string') return parseJson(input.modelBytes, {});
    return objectOrEmpty(input);
  }

  function renderer() {
    var api = globalThis.ActivationPricingJscoreRenderKind;
    if (!api || typeof api.renderKindForJscore !== 'function') {
      throw new Error('ActivationPricingJscoreRenderKind dependency is missing');
    }
    return api.renderKindForJscore;
  }

  function renderActivationPricingForJscore(modelInput) {
    var model = parseModel(modelInput);
    var sections = Array.isArray(model.sections) ? model.sections : [];
    var renderKindForJscore = renderer();
    return {
      schema: 'native-view-snapshot',
      lifecycle_key: String(model.id || 'activation-pricing'),
      root: {
        id: String(model.id || 'activation-pricing') + ':root',
        kind: 'screen',
        props: {
          revision: String(model.revision || ''),
          spacing: 14,
          padding: 16
        },
        children: sections.map(renderKindForJscore)
      },
      proof: {
        renderer: 'activation-pricing-jscore',
        modelKind: String(model.kind || ''),
        sectionCount: sections.length
      }
    };
  }

  function modelInputFromRecord(record) {
    var props = objectOrEmpty(record && record.props);
    if (typeof props.modelBytes === 'string') return props.modelBytes;
    if (typeof props.model === 'string') return props.model;
    if (props.model && typeof props.model === 'object') return props.model;
    return {
      kind: 'view-section-model',
      id: 'activation-pricing',
      revision: 'empty',
      sections: [
        {
          id: 'activation-pricing:header',
          kind: 'header',
          layoutHint: 'stack',
          payload: {
            title: 'Terms',
            summary: 'No terms are available.',
            status: 'empty'
          }
        },
        {
          id: 'activation-pricing:notice:empty',
          kind: 'notice',
          layoutHint: 'stack',
          payload: {
            tone: 'empty',
            label: 'No terms are available.'
          }
        }
      ]
    };
  }

  function mountActivationPricingJscore(record, screen) {
    var payload = renderActivationPricingForJscore(modelInputFromRecord(record));
    if (screen && typeof screen.invoke === 'function') {
      screen.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(payload));
    }
    globalThis.__thingToPutOnScreenCleanup = {
      dispose: function () {
        if (screen && typeof screen.invoke === 'function') {
          screen.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: payload.lifecycle_key }));
        }
      }
    };
    return payload;
  }

  globalThis.ActivationPricingJscore = {
    renderActivationPricingForJscore: renderActivationPricingForJscore,
    mountActivationPricingJscore: mountActivationPricingJscore
  };
  globalThis.bitfieldMount = mountActivationPricingJscore;
  globalThis.putThingOnScreen = mountActivationPricingJscore;
})();
