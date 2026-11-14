// Purpose: JavaScriptCore realization entry for the generic visual-database package.
// Invariants: package-owned source reads addressed record feeds through the
// sealed mount bridge and emits generic native snapshot operations only.

(function () {
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var PACKAGE_NAME = 'visual-database';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';

  // Field/view vocabulary ships as DATA (`visual-database.fields` /
  // `visual-database.views` genesis records). With no data present the Physics
  // fallback is shape discovery over observed keys and one unscoped list view.
  var FALLBACK_VIEWS = [
    { id: 'all', label: 'All Records', kind: 'list', order: 0, lanes: [] }
  ];

  var EMPTY_LANE = {
    id: 'unassigned',
    label: 'Unassigned',
    order: 100000,
    tone: 'neutral'
  };

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === 'string'
      ? record.lifecycle_key
      : 'component:visual-database:jscore';
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children)
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

  function runtimeTarget(mount, target, payload) {
    var responseText = mount.invoke(TARGET_INVOKE_OPERATION, JSON.stringify({
      target: target,
      payload: payload
    }));
    if (!responseText) return {};
    return JSON.parse(responseText);
  }

  function recordAddress(record) {
    return record && record.raw && typeof record.raw.address === 'string' && record.raw.address
      ? record.raw.address
      : null;
  }

  function selectedRecordRefs(record) {
    var address = recordAddress(record) || record.id;
    return address ? [{ address: address, kind: record.kind || undefined }] : [];
  }

  function inputSchemaKeys(action) {
    var keys = [];
    var input = objectOrEmpty(action.input);
    for (var key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) keys.push(key);
    }
    for (var i = 0; i < action.copy.length; i += 1) keys.push(action.copy[i].key);
    for (var j = 0; j < action.generate.length; j += 1) keys.push(action.generate[j].key);
    for (var k = 0; k < action.inputPrompts.length; k += 1) keys.push(action.inputPrompts[k].key);
    if (action.valueKey) keys.push(action.valueKey);
    return keys;
  }

  function interpretationEvent(action, target, refs, result, errorCode) {
    var event = {
      package: PACKAGE_NAME,
      event: 'visual-database.action.interpretation',
      descriptor_id: action.id,
      target: target || null,
      selected_record_count: refs.length,
      result: result,
      input_schema_keys: inputSchemaKeys(action)
    };
    if (errorCode) event.error_code = errorCode;
    return event;
  }

  function readCopySource(actionContext, source) {
    var parts = String(source || '').split('.').filter(Boolean);
    var head = parts.shift();
    var current = null;
    if (head === 'answers') current = actionContext.answers || {};
    else if (head === 'record') {
      current = {
        id: actionContext.record.id,
        title: actionContext.record.title,
        kind: actionContext.record.kind,
        group: actionContext.record.group,
        lane_id: actionContext.record.lane.id,
        date: actionContext.record.date,
        address: recordAddress(actionContext.record)
      };
    } else if (head === 'lane') current = actionContext.lane || null;
    else if (head === 'value') current = actionContext.value;
    else return undefined;
    for (var i = 0; i < parts.length; i += 1) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = current[parts[i]];
    }
    return current;
  }

  function readPackageInput(mount, inputName) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: inputName
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  function readNumber(value, fallback) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      var parsed = Number(value);
      if (isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function readPathValue(source, path) {
    var current = source;
    for (var i = 0; i < path.length; i += 1) {
      var part = path[i];
      if (Array.isArray(current)) {
        var index = Number(part);
        if (!isFinite(index) || Math.floor(index) !== index || index < 0 || index >= current.length) return undefined;
        current = current[index];
      } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  function valueToText(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return readString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i += 1) {
        var textValue = valueToText(value[i]);
        if (textValue) parts.push(textValue);
      }
      return parts.length ? parts.join(', ') : null;
    }
    if (typeof value === 'object') {
      for (var k = 0; k < 4; k += 1) {
        var key = ['label', 'title', 'name', 'id'][k];
        var keyed = valueToText(value[key]);
        if (keyed) return keyed;
      }
      return JSON.stringify(value);
    }
    return null;
  }

  function firstDescriptorValue(source, descriptors, role) {
    for (var i = 0; i < descriptors.length; i += 1) {
      var descriptor = descriptors[i];
      if (descriptor.role !== role) continue;
      for (var j = 0; j < descriptor.paths.length; j += 1) {
        var value = readPathValue(source, descriptor.paths[j]);
        if (value !== undefined && value !== null && valueToText(value) !== null) return value;
      }
    }
    return null;
  }

  function allDescriptorText(source, descriptors, role) {
    var values = [];
    for (var i = 0; i < descriptors.length; i += 1) {
      var descriptor = descriptors[i];
      if (descriptor.role !== role) continue;
      for (var j = 0; j < descriptor.paths.length; j += 1) {
        var textValue = valueToText(readPathValue(source, descriptor.paths[j]));
        if (textValue) values.push(textValue);
      }
    }
    return values;
  }

  function descriptorDomainLabel(descriptor, value) {
    var raw = valueToText(value);
    if (!raw) return null;
    var values = arrayOrEmpty(descriptor.domainValues);
    for (var i = 0; i < values.length; i += 1) {
      var entry = values[i];
      if (entry.id === raw) return entry.label || raw;
    }
    return raw;
  }

  function descriptorFirstText(source, descriptor) {
    for (var i = 0; i < descriptor.paths.length; i += 1) {
      var value = readPathValue(source, descriptor.paths[i]);
      if (value !== undefined && value !== null) return descriptorDomainLabel(descriptor, value);
    }
    return null;
  }

  function descriptorVisibleFields(source, descriptors) {
    var fields = [];
    var structural = {
      id: true,
      title: true,
      body: true,
      kind: true,
      group: true,
      lane: true,
      date: true,
      sort: true,
      link: true
    };
    for (var i = 0; i < descriptors.length; i += 1) {
      var descriptor = descriptors[i];
      var textValue = descriptorFirstText(source, descriptor);
      if (!textValue) continue;
      if (structural[descriptor.role]) continue;
      fields.push({
        id: descriptor.id,
        label: descriptor.label,
        role: descriptor.role,
        shape: descriptor.shape || '',
        value: textValue,
        rawValue: readPathValue(source, descriptor.paths[0]),
        details: []
      });
    }
    return fields;
  }

  function normalizeLane(value, order) {
    var id = readString(value);
    if (!id) return EMPTY_LANE;
    return {
      id: id,
      label: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); }),
      order: order,
      tone: 'neutral'
    };
  }

  // Attachment shape (mirrors the package's browser attachment contract):
  // an attachment object self-describes a name and ONE content source —
  // inline `content`, a `filePath`, a `url`, or a referenced record. The
  // preview never invents vocabulary; it reads the keys the package writes.
  function normalizeAttachmentItem(value) {
    if (typeof value === 'string') {
      var asText = readString(value);
      return asText ? { name: asText, kind: 'text', preview: asText } : null;
    }
    var source = objectOrEmpty(value);
    if (!Object.keys(source).length) return null;
    var name = valueToText(source.name) || valueToText(source.title)
      || valueToText(source.filePath) || valueToText(source.path)
      || valueToText(source.url) || 'Attachment';
    var content = readString(source.content) || readString(source.text);
    if (content) return { name: name, kind: 'text', preview: content };
    var filePath = readString(source.filePath) || readString(source.path);
    if (filePath) return { name: name, kind: 'file', preview: filePath };
    var url = readString(source.url);
    if (url) return { name: name, kind: 'link', preview: url };
    var reference = readString(source.reference) || readString(source.recordId) || readString(source.record_id);
    if (reference) return { name: name, kind: 'reference', preview: reference };
    return { name: name, kind: 'text', preview: JSON.stringify(source) };
  }

  function collectAttachmentItems(source, descriptors) {
    var items = [];
    for (var i = 0; i < descriptors.length; i += 1) {
      var descriptor = descriptors[i];
      if (descriptor.role !== 'attachment' && descriptor.shape !== 'attachments') continue;
      for (var j = 0; j < descriptor.paths.length; j += 1) {
        var value = readPathValue(source, descriptor.paths[j]);
        if (value === undefined || value === null) continue;
        var list = Array.isArray(value) ? value : [value];
        for (var k = 0; k < list.length; k += 1) {
          var normalized = normalizeAttachmentItem(list[k]);
          if (normalized) items.push(normalized);
        }
      }
    }
    return items;
  }

  function readRecord(source, descriptors, index) {
    var record = objectOrEmpty(source && source.payload);
    var normalizedSource = Object.keys(record).length ? {
      address: source.address,
      path: source.path,
      payload: record
    } : source;
    var id = valueToText(firstDescriptorValue(normalizedSource, descriptors, 'id')) || valueToText(source && source.address) || ('record-' + index);
    var title = valueToText(firstDescriptorValue(normalizedSource, descriptors, 'title')) || id;
    var sort = readNumber(firstDescriptorValue(normalizedSource, descriptors, 'sort'), index);
    var fields = descriptorVisibleFields(normalizedSource, descriptors);
    var attachments = [];
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].role === 'attachment' || fields[i].shape === 'attachments') attachments.push(fields[i]);
    }
    var attachmentItems = collectAttachmentItems(normalizedSource, descriptors);
    return {
      id: id,
      title: title,
      body: valueToText(firstDescriptorValue(normalizedSource, descriptors, 'body')) || '',
      kind: valueToText(firstDescriptorValue(normalizedSource, descriptors, 'kind')) || 'record',
      group: valueToText(firstDescriptorValue(normalizedSource, descriptors, 'group')) || 'Records',
      lane: normalizeLane(firstDescriptorValue(normalizedSource, descriptors, 'lane'), sort),
      date: valueToText(firstDescriptorValue(normalizedSource, descriptors, 'date')),
      sort: sort,
      badges: allDescriptorText(normalizedSource, descriptors, 'badge'),
      links: allDescriptorText(normalizedSource, descriptors, 'link'),
      fields: fields,
      attachments: attachments,
      attachmentItems: attachmentItems,
      raw: normalizedSource
    };
  }

  function compareRecords(left, right) {
    if (left.sort !== right.sort) return left.sort - right.sort;
    if ((left.date || '') !== (right.date || '')) return (left.date || '').localeCompare(right.date || '');
    if (left.title < right.title) return -1;
    if (left.title > right.title) return 1;
    return 0;
  }

  // Human gate (mirrors the browser surface): engine/system state on the
  // published feed never renders as a row. A human record carries prose —
  // a title or body with real words, not a machine token.
  function isMachineToken(value) {
    return typeof value === 'string' && value.length >= 16 && !/\s/.test(value)
      && (/[0-9a-f]{12}/i.test(value) || value.indexOf('::') !== -1);
  }

  function isHumanRecord(record) {
    var title = (record.title || '').trim();
    var body = (record.body || '').trim();
    return (title.length > 0 && !isMachineToken(title)) || (body.length > 0 && !isMachineToken(body));
  }

  function normalizeRecords(items, descriptors) {
    var records = [];
    for (var i = 0; i < items.length; i += 1) {
      var record = readRecord(items[i], descriptors, i);
      if (isHumanRecord(record)) records.push(record);
    }
    return records.sort(compareRecords);
  }

  function readFields(value) {
    var source = objectOrEmpty(value);
    var descriptors = arrayOrEmpty(source.descriptors);
    var normalized = [];
    for (var i = 0; i < descriptors.length; i += 1) {
      var descriptor = objectOrEmpty(descriptors[i]);
      var role = readString(descriptor.role);
      var id = readString(descriptor.id);
      if (!role || !id) continue;
      normalized.push({
        id: id,
        label: readString(descriptor.label) || id,
        role: role,
        shape: readString(descriptor.shape) || '',
        domainValues: arrayOrEmpty(objectOrEmpty(descriptor.domain).values).map(function (entry, index) {
          var source = objectOrEmpty(entry);
          var valueId = readString(source.id);
          return {
            id: valueId || ('value-' + index),
            label: readString(source.label) || valueId || ('Value ' + String(index + 1)),
            details: arrayOrEmpty(source.details)
          };
        }),
        domainFromRecords: arrayOrEmpty(objectOrEmpty(descriptor.domain).fromRecords || objectOrEmpty(descriptor.domain).from_records)
          .map(readViewFilter)
          .filter(Boolean),
        domainDetails: arrayOrEmpty(objectOrEmpty(descriptor.domain).details || objectOrEmpty(descriptor.domain).detail_descriptors)
          .map(readDomainDetailDescriptor)
          .filter(Boolean),
        paths: arrayOrEmpty(descriptor.paths).filter(Array.isArray)
      });
    }
    return normalized;
  }

  /** Physics fallback: discover descriptors from observed item keys when no
   *  fields data record exists. Payload keys read at ['payload', key]; bare
   *  top-level keys read at [key]. Zero vocabulary shipped in code. */
  function discoverFields(items) {
    var payloadKeys = {};
    var rowKeys = {};
    for (var i = 0; i < items.length; i += 1) {
      var item = objectOrEmpty(items[i]);
      var payload = item.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) payloadKeys[key] = true;
        }
      } else {
        for (var rowKey in item) {
          if (Object.prototype.hasOwnProperty.call(item, rowKey) && rowKey !== 'payload') rowKeys[rowKey] = true;
        }
      }
    }
    var all = {};
    var name;
    for (name in payloadKeys) { all[name] = true; }
    for (name in rowKeys) { all[name] = true; }
    var ids = Object.keys(all).sort();
    var discovered = [];
    for (var j = 0; j < ids.length; j += 1) {
      var id = ids[j];
      var paths = [];
      if (payloadKeys[id]) paths.push(['payload', id]);
      if (rowKeys[id]) paths.push([id]);
      discovered.push({ id: id, label: id, role: 'none', paths: paths });
    }
    return discovered;
  }

  function readLaneDescriptor(value, index) {
    var source = objectOrEmpty(value);
    var id = readString(source.id);
    if (!id) return null;
    return {
      id: id,
      label: readString(source.label) || id,
      order: readNumber(source.order, index),
      tone: readString(source.tone) || 'neutral'
    };
  }

  function readViewFilter(value) {
    var source = objectOrEmpty(value);
    var field = readString(source.field);
    if (!field) return null;
    var equals = arrayOrEmpty(source.equals || source.is || source.in).map(readString).filter(Boolean);
    var exclude = arrayOrEmpty(source.exclude || source.not || source.not_in).map(readString).filter(Boolean);
    if (!equals.length && !exclude.length) return null;
    return {
      field: field,
      equals: equals,
      exclude: exclude
    };
  }

  function readDomainDetailDescriptor(value) {
    var source = objectOrEmpty(value);
    var id = readString(source.id);
    var paths = arrayOrEmpty(source.paths).filter(Array.isArray);
    if (!id || !paths.length) return null;
    return {
      id: id,
      label: readString(source.label) || id,
      role: readString(source.role),
      paths: paths
    };
  }

  function readViews(value) {
    var source = objectOrEmpty(value);
    var views = arrayOrEmpty(source.views);
    if (!views.length) return FALLBACK_VIEWS;
    var normalized = [];
    for (var i = 0; i < views.length; i += 1) {
      var view = objectOrEmpty(views[i]);
      var id = readString(view.id);
      var kind = readString(view.kind);
      if (!id || !kind) continue;
      var lanes = [];
      var rules = arrayOrEmpty(view.projectionRules || view.projection_rules);
      var groupingRule = null;
      for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        var candidateRule = objectOrEmpty(rules[ruleIndex]);
        if (readString(candidateRule.operation) === 'view-group') {
          groupingRule = candidateRule;
          break;
        }
      }
      var groupingParams = objectOrEmpty(groupingRule && groupingRule.params);
      // Legacy `lanes` are accepted only at this decode boundary. Canonical
      // descriptors carry ordered view-local overrides on the view-group rule.
      var rawLanes = arrayOrEmpty(
        groupingParams.valueOverrides || groupingParams.value_overrides || view.lanes
      );
      for (var j = 0; j < rawLanes.length; j += 1) {
        var lane = readLaneDescriptor(rawLanes[j], j);
        if (lane) lanes.push(lane);
      }
      var filters = [];
      var rawFilters = arrayOrEmpty(view.filters);
      for (var k = 0; k < rawFilters.length; k += 1) {
        var filter = readViewFilter(rawFilters[k]);
        if (filter) filters.push(filter);
      }
      normalized.push({
        id: id,
        label: readString(view.label) || id,
        kind: kind,
        order: readNumber(view.order, i),
        lanes: lanes,
        filters: filters,
        groupingFieldId: readString(groupingRule && (groupingRule.sourceFieldId || groupingRule.source_field_id))
          || readString(view.groupBy || view.group_by)
          || null,
        dateField: readString(view.dateField || view.date_field) || null
      });
    }
    return normalized.length ? normalized.sort(function (left, right) { return left.order - right.order; }) : FALLBACK_VIEWS;
  }

  function readActions(value) {
    var source = objectOrEmpty(value);
    var actions = arrayOrEmpty(source.actions);
    var normalized = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = objectOrEmpty(actions[i]);
      var id = readString(action.id);
      var label = readString(action.label);
      if (!id || !label) continue;
      normalized.push({
        id: id,
        label: label,
        target: readString(action.target),
        operation: readString(action.operation),
        definitionId: readString(action.definition_id) || readString(action.definitionId),
        definitionIds: arrayOrEmpty(action.definition_ids || action.definitionIds).map(readString).filter(Boolean),
        input: objectOrEmpty(action.input),
        copy: arrayOrEmpty(action.copy || action.input_copy).map(function (entry) {
          var source = objectOrEmpty(entry);
          return {
            key: readString(source.key),
            from: readString(source.from),
            value: source.value
          };
        }).filter(function (entry) { return Boolean(entry.key); }),
        generate: arrayOrEmpty(action.generate).map(function (entry) {
          var source = objectOrEmpty(entry);
          var params = objectOrEmpty(source.params);
          var prefix = readString(source.prefix);
          if (prefix && params.prefix === undefined) params.prefix = prefix;
          return {
            key: readString(source.key),
            method: readString(source.method) || readString(source.kind),
            params: params
          };
        }).filter(function (entry) { return Boolean(entry.key && entry.method); }),
        inputPrompts: arrayOrEmpty(action.input_prompts || action.inputPrompts).map(function (entry) {
          var source = objectOrEmpty(entry);
          return { key: readString(source.key), label: readString(source.label) };
        }).filter(function (entry) { return Boolean(entry.key); }),
        valueKey: readString(action.value_key) || readString(action.valueKey),
        viewKinds: arrayOrEmpty(action.view_kinds || action.viewKinds).map(readString).filter(Boolean),
        acceptsLanes: readBoolean(action.accepts_lanes, readBoolean(action.acceptsLanes, false))
      });
    }
    return normalized;
  }

  function descriptorsForFilterField(field, descriptors) {
    for (var i = 0; i < descriptors.length; i += 1) {
      if (descriptors[i].id === field) return [descriptors[i]];
    }
    var byRole = [];
    for (var j = 0; j < descriptors.length; j += 1) {
      if (descriptors[j].role === field) byRole.push(descriptors[j]);
    }
    return byRole;
  }

  function extractTextsForDescriptor(record, descriptor) {
    var texts = [];
    var source = objectOrEmpty(record.raw);
    for (var i = 0; i < descriptor.paths.length; i += 1) {
      var textValue = valueToText(readPathValue(source, descriptor.paths[i]));
      if (textValue) texts.push(textValue);
    }
    return texts;
  }

  function matchesFilter(record, filter, descriptors) {
    var candidates = descriptorsForFilterField(filter.field, descriptors);
    var values = [];
    for (var i = 0; i < candidates.length; i += 1) {
      values = values.concat(extractTextsForDescriptor(record, candidates[i]));
    }
    values = values.map(function (value) { return String(value).toLowerCase(); });
    for (var j = 0; j < filter.exclude.length; j += 1) {
      if (values.indexOf(String(filter.exclude[j]).toLowerCase()) !== -1) return false;
    }
    if (!filter.equals.length) return true;
    for (var k = 0; k < filter.equals.length; k += 1) {
      if (values.indexOf(String(filter.equals[k]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function recordsForView(view, records, descriptors) {
    var filters = arrayOrEmpty(view && view.filters);
    if (!filters.length) return records;
    return records.filter(function (record) {
      for (var i = 0; i < filters.length; i += 1) {
        if (!matchesFilter(record, filters[i], descriptors)) return false;
      }
      return true;
    });
  }

  function projectDomainDetails(sourceRecord, detailDescriptors) {
    var details = [];
    for (var i = 0; i < detailDescriptors.length; i += 1) {
      var descriptor = detailDescriptors[i];
      var value = null;
      for (var j = 0; j < descriptor.paths.length; j += 1) {
        value = valueToText(readPathValue(sourceRecord.raw, descriptor.paths[j]));
        if (value) break;
      }
      if (value) details.push({
        id: descriptor.id,
        label: descriptor.label,
        value: value,
        role: descriptor.role || null,
        ref: sourceRecord.id
      });
    }
    return details;
  }

  function selectedFieldValues(field) {
    var raw = field.rawValue;
    var values = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
    return values.map(valueToText).filter(Boolean);
  }

  function enrichFieldDetails(records, descriptors) {
    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      for (var f = 0; f < record.fields.length; f += 1) {
        var field = record.fields[f];
        var descriptor = null;
        for (var d = 0; d < descriptors.length; d += 1) {
          if (descriptors[d].id === field.id) descriptor = descriptors[d];
        }
        if (!descriptor || !descriptor.domainDetails.length || !descriptor.domainFromRecords.length) continue;
        var selected = selectedFieldValues(field);
        var details = [];
        for (var r = 0; r < records.length; r += 1) {
          var sourceRecord = records[r];
          var passes = true;
          for (var filterIndex = 0; filterIndex < descriptor.domainFromRecords.length; filterIndex += 1) {
            if (!matchesFilter(sourceRecord, descriptor.domainFromRecords[filterIndex], descriptors)) passes = false;
          }
          if (!passes) continue;
          if (selected.indexOf(sourceRecord.id) === -1 && selected.indexOf(sourceRecord.title) === -1) continue;
          details = details.concat(projectDomainDetails(sourceRecord, descriptor.domainDetails));
        }
        field.details = details;
      }
    }
    return records;
  }

  function loadModel(mount) {
    var fields = readFields(readPackageInput(mount, 'fields'));
    var views = readViews(readPackageInput(mount, 'views'));
    var actions = readActions(readPackageInput(mount, 'actions'));
    var records = [];
    var recordsDelivered = true;
    try {
      var rawRecords = readPackageInput(mount, 'records');
      // null/undefined feed = the runtime has not delivered records yet
      // (loading/pending). An empty array = delivered, no matches (empty).
      recordsDelivered = rawRecords !== null && rawRecords !== undefined;
      var items = arrayOrEmpty(rawRecords);
      if (!fields.length) fields = discoverFields(items);
      records = enrichFieldDetails(normalizeRecords(items, fields), fields);
    } catch (error) {
      records = [];
      recordsDelivered = false;
    }
    return {
      records: records,
      recordsDelivered: recordsDelivered,
      fields: fields,
      views: views,
      actions: actions
    };
  }

  function lanesForView(view, records) {
    var map = {};
    var lanes = [];
    for (var i = 0; i < view.lanes.length; i += 1) {
      var lane = view.lanes[i];
      map[lane.id] = true;
      lanes.push(lane);
    }
    for (var j = 0; j < records.length; j += 1) {
      var recordLane = records[j].lane;
      if (!map[recordLane.id]) {
        map[recordLane.id] = true;
        lanes.push(recordLane);
      }
    }
    if (!lanes.length) lanes.push(EMPTY_LANE);
    return lanes.sort(function (left, right) {
      if (left.order !== right.order) return left.order - right.order;
      return left.label.localeCompare(right.label);
    });
  }

  function actionsForView(actions, view) {
    var visible = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i];
      if (!action.viewKinds.length || action.viewKinds.indexOf(view.kind) !== -1 || action.viewKinds.indexOf(view.id) !== -1) {
        visible.push(action);
      }
    }
    return visible;
  }

  function badge(label, tone) {
    var background = tone === 'success' ? '#183d28' : tone === 'warning' ? '#493715' : tone === 'error' ? '#4b1c1c' : '#171b24';
    return node('box', {
      background: background,
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 7,
      fillWidth: false
    }, [text(label, 10, 'semibold', 'darkTextSecondary', 1)]);
  }

  function buildActionInput(action, record, lane, value, answers) {
    var input = {};
    var sourceInput = objectOrEmpty(action.input);
    for (var key in sourceInput) {
      if (Object.prototype.hasOwnProperty.call(sourceInput, key)) input[key] = sourceInput[key];
    }
    if (action.generate.length) {
      input.requested_values = action.generate.map(function (requested) {
        return { key: requested.key, method: requested.method, params: requested.params || {} };
      });
    }
    var actionContext = { record: record, lane: lane, value: value, answers: answers || {} };
    for (var j = 0; j < action.copy.length; j += 1) {
      var copy = action.copy[j];
      var copied = copy.from ? readCopySource(actionContext, copy.from) : copy.value;
      if (copied !== undefined) input[copy.key] = copied;
    }
    if (action.valueKey && value !== undefined) input[action.valueKey] = value;
    input.action_id = action.id;
    input.action_label = action.label;
    input.record_id = record.id;
    input.record_title = record.title;
    input.record_kind = record.kind;
    input.current_lane_id = record.lane.id;
    input.target_lane_id = lane ? lane.id : null;
    input.record = {
      id: record.id,
      title: record.title,
      kind: record.kind,
      group: record.group,
      lane_id: record.lane.id,
      date: record.date,
      address: record.raw && record.raw.address ? record.raw.address : null
    };
    input.lane = lane ? { id: lane.id, label: lane.label } : null;
    return input;
  }

  function buildActionRequest(action, record, lane, value, answers) {
    var target = action.target && String(action.target).trim();
    var refs = selectedRecordRefs(record);
    if (!target) {
      return {
        ok: false,
        error: {
          code: 'missing-target',
          descriptor_id: action.id,
          package_id: PACKAGE_NAME,
          missing_field: 'target',
          selected_record_refs: refs
        },
        event: interpretationEvent(action, null, refs, 'descriptor-error', 'missing-target')
      };
    }
    var input = buildActionInput(action, record, lane, value, answers);
    var definitionIds = action.definitionIds.length ? action.definitionIds : (action.definitionId ? [action.definitionId] : []);
    var source = { package: PACKAGE_NAME, surface: PACKAGE_NAME, descriptor_id: action.id };
    var correlationId = ['visual-database-action', action.id, recordAddress(record) || record.id].join(':');
    var actionName = definitionIds.length ? 'execute_definition' : (action.operation || action.id);
    var requests = [];
    for (var i = 0; i < definitionIds.length; i += 1) {
      requests.push({
        target: target,
        action: actionName,
        correlation_id: correlationId,
        payload: {
          operation: 'execute_definition',
          definition_id: definitionIds[i],
          include_steps: false,
          include_output: false,
          input: input
        },
        source: source,
        selected_record_refs: refs
      });
    }
    if (!requests.length) {
      requests.push({
        target: target,
        action: actionName,
        correlation_id: correlationId,
        payload: {
          operation: action.operation || action.id,
          action_id: action.id,
          input: input
        },
        source: source,
        selected_record_refs: refs
      });
    }
    return {
      ok: true,
      requests: requests,
      event: interpretationEvent(action, target, refs, 'request')
    };
  }

  function actionButton(action, record, lane) {
    var result = buildActionRequest(action, record, lane);
    var request = result.ok ? result.requests[0] : null;
    return node('box', {
      background: request ? '#101826' : '#2a1216',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 8,
      fillWidth: false,
      press: request ? {
        operation: TARGET_INVOKE_OPERATION,
        payload: request
      } : undefined
    }, [text(request ? (lane ? ('Move to ' + lane.label) : action.label) : 'Action descriptor needs target', 10, 'semibold', request ? 'accent' : '#ff8a8a', 1)]);
  }

  function actionRow(actions, lanes, record) {
    if (!actions.length) return null;
    var buttons = [];
    for (var i = 0; i < actions.length && buttons.length < 4; i += 1) {
      var action = actions[i];
      if (action.acceptsLanes) {
        for (var j = 0; j < lanes.length && buttons.length < 4; j += 1) {
          if (lanes[j].id !== record.lane.id) buttons.push(actionButton(action, record, lanes[j]));
        }
      } else {
        buttons.push(actionButton(action, record, null));
      }
    }
    return buttons.length ? node('stack', { axis: 'horizontal', spacing: 7 }, buttons) : null;
  }

  // Inline attachment preview: text attachments show their content (clamped),
  // file/link/reference attachments show name + source. Native node set is
  // box/stack/text, so a text preview is the parity-correct realization.
  function attachmentPreviewBlock(item) {
    var icon = item.kind === 'file' ? '📄 ' : item.kind === 'link' ? '🔗 ' : item.kind === 'reference' ? '↪ ' : '📝 ';
    var children = [text(icon + item.name, 11, 'semibold', 'darkTextPrimary', 1)];
    if (item.kind === 'text') {
      children.push(text(item.preview, 11, 'regular', 'darkTextSecondary', 8));
    } else {
      children.push(text(item.preview, 10, 'regular', 'darkTextSecondary', 2));
    }
    return node('box', {
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 10,
      spacing: 5
    }, children);
  }

  function attachmentPreviewSection(record) {
    var items = arrayOrEmpty(record.attachmentItems);
    if (!items.length) return null;
    var blocks = [];
    for (var i = 0; i < items.length && i < 4; i += 1) blocks.push(attachmentPreviewBlock(items[i]));
    return node('stack', { axis: 'vertical', spacing: 7 }, blocks);
  }

  function recordCard(record, lanes, actions) {
    var children = [
      node('stack', { axis: 'horizontal', spacing: 10 }, [
        node('stack', { axis: 'vertical', spacing: 4 }, [
          text(record.title, 15, 'semibold', 'darkTextPrimary', 2),
          text(record.kind + ' · ' + record.group, 11, 'regular', 'darkTextSecondary', 2)
        ]),
        badge(record.lane.label, record.lane.tone)
      ])
    ];
    if (record.body) children.push(text(record.body, 12, 'regular', 'darkTextSecondary', 4));
    if (record.date) children.push(text(record.date, 10, 'regular', 'darkTextSecondary', 1));
    var metadata = [];
    for (var m = 0; m < record.fields.length && metadata.length < 6; m += 1) {
      var field = record.fields[m];
      // Attachments now render as inline previews below — not as a badge.
      if (field.role === 'attachment' || field.shape === 'attachments') continue;
      metadata.push(badge(field.label + ': ' + field.value, 'neutral'));
      var details = arrayOrEmpty(field.details);
      for (var d = 0; d < details.length && metadata.length < 6; d += 1) {
        metadata.push(badge(details[d].label + ': ' + details[d].value, 'neutral'));
      }
    }
    if (metadata.length) children.push(node('stack', { axis: 'horizontal', spacing: 6, wrap: true }, metadata));
    var previews = attachmentPreviewSection(record);
    if (previews) children.push(previews);
    var actionsNode = actionRow(actions, lanes, record);
    if (actionsNode) children.push(actionsNode);
    return node('box', {
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 9
    }, children);
  }

  // Amie date buckets (mirrors the browser surface): records group under
  // temporal sections relative to today; completed records (success-tone
  // lane) always separate into a trailing Completed section.
  function dateBucketOf(record, todayIso) {
    var match = (record.date || '').match(/\d{4}-\d{2}-\d{2}/);
    if (!match) return 'No date';
    if (match[0] === todayIso) return 'Today';
    var diffDays = Math.round((Date.parse(match[0]) - Date.parse(todayIso)) / 86400000);
    if (diffDays === -1) return 'Yesterday';
    if (diffDays === 1) return 'Tomorrow';
    return diffDays < 0 ? 'Earlier' : 'Later';
  }

  var DATE_BUCKET_ORDER = ['Earlier', 'Yesterday', 'Today', 'Tomorrow', 'Later', 'No date'];

  function buildList(records, lanes, actions) {
    var todayIso = new Date().toISOString().slice(0, 10);
    var open = [];
    var completed = [];
    for (var i = 0; i < records.length && i < 48; i += 1) {
      if (records[i].lane && records[i].lane.tone === 'success') completed.push(records[i]);
      else open.push(records[i]);
    }
    var rows = [];
    function pushSection(label, sectionRecords) {
      rows.push(node('stack', { axis: 'horizontal', spacing: 6 }, [
        text(label, 12, 'semibold', 'darkTextSecondary', 1),
        text(String(sectionRecords.length), 11, 'regular', 'darkTextSecondary', 1)
      ]));
      for (var r = 0; r < sectionRecords.length; r += 1) rows.push(recordCard(sectionRecords[r], lanes, actions));
    }
    for (var b = 0; b < DATE_BUCKET_ORDER.length; b += 1) {
      var label = DATE_BUCKET_ORDER[b];
      var bucketRecords = [];
      for (var j = 0; j < open.length; j += 1) {
        if (dateBucketOf(open[j], todayIso) === label) bucketRecords.push(open[j]);
      }
      // Today persists at 0 (structure survives an empty list); other buckets
      // render only when populated.
      if (bucketRecords.length > 0 || label === 'Today') pushSection(label, bucketRecords);
    }
    pushSection('Completed', completed);
    return node('stack', { axis: 'vertical', spacing: 11 }, rows);
  }

  function buildBoard(records, lanes, actions) {
    var columns = [];
    for (var i = 0; i < lanes.length && i < 8; i += 1) {
      var lane = lanes[i];
      var laneRecords = [];
      for (var j = 0; j < records.length; j += 1) {
        if (records[j].lane.id === lane.id) laneRecords.push(records[j]);
      }
      var cards = [
        node('stack', { axis: 'horizontal', spacing: 8 }, [
          text(lane.label, 13, 'bold', 'darkTextPrimary', 1),
          badge(String(laneRecords.length), lane.tone)
        ])
      ];
      for (var k = 0; k < laneRecords.length && k < 10; k += 1) cards.push(recordCard(laneRecords[k], lanes, actions));
      if (laneRecords.length === 0) cards.push(text('No records in this lane.', 11, 'regular', 'darkTextSecondary', 2));
      columns.push(node('box', {
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 12,
        spacing: 10
      }, cards));
    }
    return node('grid', { columns: 2, spacing: 10 }, columns);
  }

  // Parity with show/timeline-grouping.ts timelineBucketKey: bucket boundary
  // for an ISO day at a zoom level. Unknown zooms degrade to the day itself.
  function timelineBucketKey(isoDay, zoom) {
    if (zoom === 'year') return isoDay.slice(0, 4);
    if (zoom === 'quarter') {
      var month = parseInt(isoDay.slice(5, 7), 10);
      return isoDay.slice(0, 4) + '-Q' + String(Math.floor((month - 1) / 3) + 1);
    }
    if (zoom === 'month') return isoDay.slice(0, 7);
    if (zoom === 'week') {
      var parts = isoDay.split('-');
      var date = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
      var dow = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - dow);
      return date.toISOString().slice(0, 10);
    }
    return isoDay;
  }

  function buildTimeline(records, lanes, actions, zoom) {
    var sorted = records.slice().sort(function (left, right) {
      return (left.date || '').localeCompare(right.date || '') || left.title.localeCompare(right.title);
    });
    var rows = [];
    var lastBucket = null;
    for (var i = 0; i < sorted.length && i < 48; i += 1) {
      var dayMatch = (sorted[i].date || '').match(/\d{4}-\d{2}-\d{2}/);
      var bucket = dayMatch ? timelineBucketKey(dayMatch[0], zoom) : 'No date';
      if (bucket !== lastBucket) {
        rows.push(node('stack', { axis: 'horizontal', spacing: 10 }, [
          badge(bucket, 'neutral')
        ]));
        lastBucket = bucket;
      }
      rows.push(node('stack', { axis: 'horizontal', spacing: 10 }, [
        recordCard(sorted[i], lanes, actions)
      ]));
    }
    return node('stack', { axis: 'vertical', spacing: 11 }, rows);
  }

  function buildSwimlanes(records, lanes, actions) {
    var groups = [];
    var groupMap = {};
    for (var i = 0; i < records.length; i += 1) {
      if (!groupMap[records[i].group]) {
        groupMap[records[i].group] = true;
        groups.push(records[i].group);
      }
    }
    groups.sort();
    var rows = [];
    for (var g = 0; g < groups.length && g < 12; g += 1) {
      var group = groups[g];
      var groupChildren = [
        text(group, 14, 'bold', 'darkTextPrimary', 1)
      ];
      for (var l = 0; l < lanes.length && l < 6; l += 1) {
        var lane = lanes[l];
        var laneCards = [badge(lane.label, lane.tone)];
        for (var r = 0; r < records.length; r += 1) {
          if (records[r].group === group && records[r].lane.id === lane.id) laneCards.push(recordCard(records[r], lanes, actions));
        }
        groupChildren.push(node('box', {
          background: 'darkSurface',
          border: 'darkBorder',
          borderWidth: 1,
          cornerRadius: 14,
          padding: 10,
          spacing: 8
        }, laneCards));
      }
      rows.push(node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 12,
        spacing: 10
      }, groupChildren));
    }
    return node('stack', { axis: 'vertical', spacing: 12 }, rows);
  }

  function buildSnapshotForView(key, model, view, includeSelector) {
    var scopedRecords = recordsForView(view, model.records, model.fields);
    var lanes = lanesForView(view, scopedRecords);
    var actions = actionsForView(model.actions, view);
    var body;
    if (scopedRecords.length === 0 && model.recordsDelivered === false) {
      // Loading / pending: the record feed has not arrived yet.
      body = node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 18,
        spacing: 8
      }, [
        text('Loading records…', 17, 'semibold', 'darkTextPrimary', 2),
        text('Waiting for the current record feed to deliver to this device.', 13, 'regular', 'darkTextSecondary', 3)
      ]);
    } else if (scopedRecords.length === 0) {
      body = node('box', {
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 18,
        spacing: 8
      }, [
        text('No addressed records match this list yet.', 17, 'semibold', 'darkTextPrimary', 2),
        text('This view is mounted and waiting on matching records from the current feed.', 13, 'regular', 'darkTextSecondary', 3)
      ]);
    } else if (view.kind === 'board' || view.kind === 'table' || view.kind === 'graph') {
      body = buildBoard(scopedRecords, lanes, actions);
    } else if (view.kind === 'timeline') {
      body = buildTimeline(scopedRecords, lanes, actions, view.zoom);
    } else if (view.kind === 'swimlane') {
      body = buildSwimlanes(scopedRecords, lanes, actions);
    } else {
      body = buildList(scopedRecords, lanes, actions);
    }

    var children = [
      node('stack', { axis: 'horizontal', spacing: 10 }, [
        node('box', {
          background: 'darkSurfaceRaised',
          cornerRadius: 10,
          padding: 8,
          fillWidth: false
        }, [text('Records', 12, 'bold', 'darkTextPrimary')]),
        text('native JSCore package artifact', 12, 'regular', 'darkTextSecondary', 1)
      ]),
      text('Visual Database', 32, 'bold', 'darkTextPrimary', 2),
      text(view.label + ' · ' + String(scopedRecords.length) + ' addressed records · ' + String(lanes.length) + ' lanes', 13, 'regular', 'darkTextSecondary', 2)
    ];
    if (includeSelector !== false) children.push(viewSelector(key, model, view.id));
    children.push(body);

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

  function viewSelector(key, model, activeViewId) {
    var cards = [];
    for (var i = 0; i < model.views.length && i < 8; i += 1) {
      var view = model.views[i];
      cards.push(node('box', {
        background: view.id === activeViewId ? '#14243a' : 'darkSurfaceRaised',
        border: view.id === activeViewId ? 'accent' : 'darkBorder',
        borderWidth: 1,
        cornerRadius: 14,
        padding: 10,
        fillWidth: false,
        press: {
          operation: SNAPSHOT_REPLACE_OPERATION,
          payload: buildSnapshotForView(key, model, view, false)
        }
      }, [text(view.label, 11, 'semibold', view.id === activeViewId ? 'accent' : 'darkTextSecondary', 1)]));
    }
    return node('stack', { axis: 'horizontal', spacing: 8 }, cards);
  }

  function mountVisualDatabase(record, mount) {
    var key = lifecycleKey(record);
    try {
      var model = loadModel(mount);
      var view = model.views[0] || FALLBACK_VIEWS[0];
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshotForView(key, model, view, true)));
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
          text('Visual Database JSCore mount failed', 24, 'bold', 'darkTextPrimary', 2),
          text(String(error && error.message ? error.message : error), 13, 'regular', '#ff6b6b', 8)
        ])
      }));
    }
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.bitfieldMount = mountVisualDatabase;
  globalThis.mount = mountVisualDatabase;
  globalThis.__visualDatabaseJscoreConformance = {
    buildActionRequest: buildActionRequest,
    readActions: readActions
  };
}());
