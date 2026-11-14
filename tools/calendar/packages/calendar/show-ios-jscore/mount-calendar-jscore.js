// Purpose: JavaScriptCore realization entry for the Calendar package.
// Invariant: the Apple app is a blind screen host; Calendar owns only the
// interval/action model translation and sealed native snapshot operations.

(function () {
  var PACKAGE_NAME = 'calendar';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === 'string'
      ? record.lifecycle_key
      : 'component:calendar:jscore';
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: props && typeof props === 'object' && !Array.isArray(props) ? props : {},
      children: Array.isArray(children) ? children : []
    };
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

  function readPackageInput(mount, inputName) {
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

  function failureSnapshot(key, error) {
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 12
      }, [
        text('Calendar could not open', 24, 'bold', 'darkTextPrimary', 2),
        text(String(error && error.message ? error.message : error), 13, 'regular', '#ff8f8f', 6)
      ])
    };
  }

  function mountCalendar(record, mount) {
    var key = lifecycleKey(record);
    try {
      var renderer = globalThis.CalendarJscoreRenderer;
      if (!renderer || typeof renderer.renderCalendarNativeSnapshot !== 'function') {
        throw new Error('Calendar native renderer was not loaded.');
      }
      var feed = readPackageInput(mount, 'time-blocks');
      var snapshot = renderer.renderCalendarNativeSnapshot(feed || {}, key);
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
      if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
        console.log('[calendar] rendered iOS calendar model', JSON.stringify(snapshot.summary || {}));
      }
    } catch (error) {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(failureSnapshot(key, error)));
    }
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.bitfieldMount = mountCalendar;
  globalThis.mount = mountCalendar;
}());
