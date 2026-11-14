// Purpose: JavaScriptCore realization entry for the chat package.
// Invariants: package-owned source reads package-owned projected feeds through
// the sealed mount bridge and emits generic native snapshot operations only.

(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === 'string'
      ? record.lifecycle_key
      : 'component:chat:jscore';
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

  function findItems(mount, kind, limit) {
    var reply = runtimeTarget(mount, 'find-current-items', {
      operation: 'find-current-items',
      in: kind,
      include: ['address', 'payload'],
      limit: limit
    });
    return arrayOrEmpty(reply.items);
  }

  function readString(record, key) {
    var value = record && record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  function readNumber(record, key) {
    var value = record && record[key];
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      var parsed = Number(value);
      if (isFinite(parsed)) return parsed;
    }
    return null;
  }

  function payloadOf(item) {
    return objectOrEmpty(item && item.payload);
  }

  function normalizeSession(item, index) {
    var payload = payloadOf(item);
    var recordId = readString(payload, 'recordId') || readString(payload, 'record_id') || readString(item, 'address');
    if (!recordId) return null;
    var startedAt = readString(payload, 'startedAt') || readString(payload, 'started_at') || '';
    return {
      id: recordId,
      sessionId: readString(payload, 'sessionId') || readString(payload, 'session_id') || recordId,
      title: readString(payload, 'title') || readString(payload, 'prompt') || ('Chat session ' + (index + 1)),
      participantRef: readString(payload, 'participantRef')
        || readString(payload, 'participant_ref')
        || readString(payload, 'agentId')
        || readString(payload, 'agent_id')
        || 'unknown participant',
      model: readString(payload, 'model') || '',
      projectName: readString(payload, 'projectName') || readString(payload, 'project_name') || '',
      projectSlug: readString(payload, 'projectSlug') || readString(payload, 'project_slug') || '',
      prompt: readString(payload, 'prompt') || '',
      accountDir: readString(payload, 'accountDir') || readString(payload, 'account_dir') || '',
      filePath: readString(payload, 'filePath') || readString(payload, 'file_path') || '',
      startedAt: startedAt,
      lastActivityAt: readString(payload, 'lastActivityAt') || readString(payload, 'last_activity_at') || startedAt,
      messageCount: readNumber(payload, 'messageCount') || readNumber(payload, 'message_count') || 0
    };
  }

  function sortSessions(left, right) {
    var leftTime = left.lastActivityAt || left.startedAt || '';
    var rightTime = right.lastActivityAt || right.startedAt || '';
    if (leftTime > rightTime) return -1;
    if (leftTime < rightTime) return 1;
    if (left.title < right.title) return -1;
    if (left.title > right.title) return 1;
    return 0;
  }

  function loadSessions(mount) {
    try {
      var items = findItems(mount, 'chat-sessions', 32);
      var sessions = [];
      for (var i = 0; i < items.length; i += 1) {
        var session = normalizeSession(items[i], i);
        if (session) sessions.push(session);
      }
      return sessions.sort(sortSessions);
    } catch (error) {
      return [];
    }
  }

  function normalizeTranscriptRows(items) {
    var grouped = {};
    for (var i = 0; i < items.length; i += 1) {
      var row = payloadOf(items[i]);
      var subjectId = readString(row, 'subject_id');
      var propertyId = readString(row, 'property_id');
      if (!subjectId || !propertyId) continue;
      var current = grouped[subjectId] || {
        transcriptId: subjectId,
        sessionId: '',
        content: '',
        messageCount: 0
      };
      if (propertyId === 'prop:session_transcript:session_id') {
        current.sessionId = readString(row, 'value') || current.sessionId;
      } else if (propertyId === 'prop:session_transcript:transcript_content') {
        current.content = readString(row, 'value') || current.content;
      } else if (propertyId === 'prop:session_transcript:message_count') {
        current.messageCount = readNumber(row, 'value') || current.messageCount;
      }
      grouped[subjectId] = current;
    }
    return grouped;
  }

  function loadTranscripts(mount) {
    try {
      return normalizeTranscriptRows(findItems(mount, 'session-transcripts', 256));
    } catch (error) {
      return {};
    }
  }

  function transcriptForSession(transcripts, session) {
    var best = null;
    for (var key in transcripts) {
      if (!Object.prototype.hasOwnProperty.call(transcripts, key)) continue;
      var transcript = transcripts[key];
      if (transcript.sessionId === session.sessionId || transcript.sessionId === session.id) {
        best = transcript;
        break;
      }
    }
    return best;
  }

  function parseTranscriptLines(transcript) {
    if (!transcript || !transcript.content) return [];
    try {
      var parsed = JSON.parse(transcript.content);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.data)) return parsed.data;
    } catch (error) {
      return [{ role: 'transcript', content: transcript.content }];
    }
    return [];
  }

  function lineRole(line) {
    if (!line || typeof line !== 'object') return 'Message';
    var role = typeof line.role === 'string' ? line.role.toLowerCase() : '';
    if (role === 'human' || role === 'user') return 'You';
    if (role === 'assistant' || role === 'agent') return 'Assistant';
    return 'Message';
  }

  function lineContent(line) {
    if (!line || typeof line !== 'object') return String(line || '');
    if (typeof line.content === 'string') return line.content;
    if (typeof line.text === 'string') return line.text;
    return '';
  }

  function isPrivateWorkLine(line) {
    if (!line || typeof line !== 'object') return false;
    var kind = String(line.type || line.role || '').toLowerCase();
    return kind === 'thinking'
      || kind === 'tool_use'
      || kind === 'tool_result'
      || kind === 'system'
      || kind === 'compaction';
  }

  function visibleMessageText(value) {
    var content = String(value || '').trim();
    if (!content) return '';
    if (/(?:\b(?:payload|receipt|projection|workflow|dispatcher|producer|adapter|authority|cryptographic|envelope|transport|binding|jscore|webkit|react)\b|(?:package|action|proof|slot)::?|\b1f:[0-9a-f]{16,}|\b[a-z][a-z0-9_-]+:[a-z0-9:_-]+\b)/i.test(content)) {
      return 'Your assistant finished this step.';
    }
    return content;
  }

  function shortDate(value) {
    if (!value) return '';
    return value.replace('T', ' ').replace('.000Z', '').replace('Z', '');
  }

  function metaText(session) {
    var parts = [];
    if (session.projectName || session.projectSlug) parts.push(session.projectName || session.projectSlug);
    if (session.messageCount) parts.push(String(session.messageCount) + ' messages');
    return parts.join(' · ');
  }

  function badge(label) {
    return node('box', {
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 11,
      padding: 7,
      fillWidth: false
    }, [text(label.slice(0, 2).toUpperCase(), 10, 'bold', 'accent')]);
  }

  function sessionCard(session, transcript, key) {
    return node('box', {
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 9,
      press: {
        operation: SNAPSHOT_REPLACE_OPERATION,
        payload: buildSessionSnapshot(key, session, transcript)
      }
    }, [
      node('stack', { axis: 'horizontal', spacing: 11 }, [
        badge(session.title || 'Chat'),
        node('stack', { axis: 'vertical', spacing: 4 }, [
          text(session.title, 15, 'semibold', 'darkTextPrimary', 2),
          text(metaText(session) || 'Conversation', 11, 'regular', 'darkTextSecondary', 2),
          text(shortDate(session.lastActivityAt), 10, 'regular', 'darkTextSecondary', 1)
        ])
      ])
    ]);
  }

  function buildMessagePreview(lines) {
    if (!lines.length) {
      return node('box', {
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 16,
        padding: 14,
        spacing: 6
      }, [
        text('No messages are available yet.', 12, 'regular', 'darkTextSecondary')
      ]);
    }
    var rows = [];
    var start = Math.max(0, lines.length - 8);
    for (var i = start; i < lines.length; i += 1) {
      if (isPrivateWorkLine(lines[i])) continue;
      var role = lineRole(lines[i]);
      var content = visibleMessageText(lineContent(lines[i]));
      if (!content) continue;
      rows.push(node('box', {
        background: role === 'You' ? '#14345f' : 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 14,
        padding: 12,
        spacing: 5
      }, [
        text(role, 10, 'bold', role === 'You' ? '#9ac2ff' : 'darkTextSecondary', 1),
        text(content, 12, 'regular', 'darkTextPrimary', 6)
      ]));
    }
    return node('stack', { axis: 'vertical', spacing: 10 }, rows);
  }

  function buildSessionSnapshot(key, session, transcript) {
    var lines = parseTranscriptLines(transcript);
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 16
      }, [
        node('stack', { axis: 'horizontal', spacing: 10 }, [
          node('box', {
            background: 'darkSurfaceRaised',
            cornerRadius: 10,
            padding: 8,
            fillWidth: false
          }, [text('Chat', 12, 'bold', 'darkTextPrimary')]),
          text('Conversation', 12, 'regular', 'darkTextSecondary')
        ]),
        text(session.title, 28, 'semibold', 'darkTextPrimary', 3),
        text(metaText(session) || 'Conversation', 12, 'regular', 'darkTextSecondary', 3),
        node('box', {
          background: 'darkSurfaceRaised',
          border: 'darkBorder',
          borderWidth: 1,
          cornerRadius: 16,
          padding: 14,
          spacing: 7
        }, [
          text('Request', 11, 'bold', 'darkTextSecondary'),
          text(visibleMessageText(session.prompt) || 'No request was saved for this conversation.', 12, 'regular', 'darkTextPrimary', 5)
        ]),
        text('Latest messages', 12, 'bold', 'darkTextSecondary'),
        buildMessagePreview(lines)
      ])
    };
  }

  function buildEmptySnapshot(key) {
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 26,
        spacing: 18
      }, [
        text('Chat', 34, 'bold', 'darkTextPrimary'),
        text('Your assistant keeps working even when chat is quiet.', 15, 'regular', 'darkTextSecondary'),
        node('box', {
          background: 'darkSurfaceRaised',
          border: 'darkBorder',
          borderWidth: 1,
          cornerRadius: 18,
          padding: 18,
          spacing: 8
        }, [
          text('Your conversations will appear here', 17, 'semibold', 'darkTextPrimary'),
          text('Ask anything when you are ready.', 13, 'regular', 'darkTextSecondary')
        ])
      ])
    };
  }

  function buildSnapshot(record, mount) {
    var key = lifecycleKey(record);
    var sessions = loadSessions(mount);
    var transcripts = loadTranscripts(mount);
    if (sessions.length === 0) return buildEmptySnapshot(key);

    var cards = [];
    for (var i = 0; i < sessions.length && i < 16; i += 1) {
      cards.push(sessionCard(sessions[i], transcriptForSession(transcripts, sessions[i]), key));
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
      }, [
        node('stack', { axis: 'horizontal', spacing: 10 }, [
          node('box', {
            background: 'darkSurfaceRaised',
            cornerRadius: 10,
            padding: 8,
            fillWidth: false
          }, [text('Chat', 12, 'bold', 'darkTextPrimary')]),
          text('Conversations', 12, 'regular', 'darkTextSecondary')
        ]),
        text('Conversations', 31, 'bold', 'darkTextPrimary'),
        text(String(sessions.length) + ' conversations · Choose one to see the latest messages', 13, 'regular', 'darkTextSecondary', 2),
        node('stack', { axis: 'vertical', spacing: 11 }, cards)
      ])
    };
  }

  function mountChat(record, mount) {
    var key = lifecycleKey(record);
    try {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(record, mount)));
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
          text('Chat couldn\'t open', 24, 'bold', 'darkTextPrimary'),
          text('Close and reopen Chat.', 13, 'regular', '#ff6b6b', 8)
        ])
      }));
    }
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.bitfieldMount = mountChat;
  globalThis.mount = mountChat;
}());
