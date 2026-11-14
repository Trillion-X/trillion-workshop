// Purpose: JavaScriptCore realization entry for the email-client package.
// Invariants: the package reads the same communication-work-items projection as the
// browser surface and emits sealed native snapshot / target-invoke operations.

(function () {
  var PACKAGE_NAME = 'email-client';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === 'string'
      ? record.lifecycle_key
      : 'component:email-client:jscore';
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

  function stack(axis, spacing, children, props) {
    var merged = objectOrEmpty(props);
    merged.axis = axis;
    merged.spacing = spacing;
    return node('stack', merged, children);
  }

  function box(props, children, id) {
    return node('box', props, children, id);
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

  function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  }

  function readStringOr(value, fallback) {
    var normalized = readString(value);
    return normalized || fallback;
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function readStringArray(value) {
    return arrayOrEmpty(value)
      .filter(function (item) { return typeof item === 'string' && item.trim().length > 0; })
      .map(function (item) { return item.trim(); });
  }

  function unwrapFeed(value) {
    var record = objectOrEmpty(value);
    if (record.feed && typeof record.feed === 'object') return objectOrEmpty(record.feed);
    if (record.mail_work_items && typeof record.mail_work_items === 'object') return objectOrEmpty(record.mail_work_items);
    if (record.mailWorkItems && typeof record.mailWorkItems === 'object') return objectOrEmpty(record.mailWorkItems);
    return record;
  }

  function sourceLink(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    if (!address) return null;
    return { address: address, label: readStringOr(record.label, 'Source message') };
  }

  function normalizeAction(value) {
    var record = objectOrEmpty(value);
    var id = readString(record.id);
    var target = readString(record.target);
    var operation = readString(record.operation);
    if (!id || !target || !operation) return null;
    return {
      id: id,
      label: readStringOr(record.label, 'Action'),
      target: target,
      operation: operation,
      definitionId: readString(record.definitionId) || readString(record.definition_id),
      disabledReason: readString(record.disabledReason),
      undoActionId: readString(record.undoActionId)
    };
  }

  function normalizeAccount(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    if (!address) return null;
    return {
      address: address,
      name: readStringOr(record.name, 'Connected account'),
      color: readString(record.color),
      canRead: readBoolean(record.canRead, true),
      canSend: readBoolean(record.canSend, true),
      repairActionId: readString(record.repairActionId)
    };
  }

  function normalizeMailbox(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    if (!address) return null;
    return {
      address: address,
      label: readStringOr(record.label, 'Mailbox'),
      accountAddress: readString(record.accountAddress),
      messageAddresses: readStringArray(record.messageAddresses)
    };
  }

  function normalizeMessage(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    var threadAddress = readString(record.threadAddress);
    var accountAddress = readString(record.accountAddress);
    if (!address || !threadAddress || !accountAddress) return null;
    return {
      address: address,
      threadAddress: threadAddress,
      accountAddress: accountAddress,
      mailboxAddresses: readStringArray(record.mailboxAddresses),
      sender: readStringOr(record.sender, 'Unknown sender'),
      recipients: readStringArray(record.recipients),
      subject: readStringOr(record.subject, 'No subject'),
      preview: readString(record.preview),
      body: readString(record.body),
      bodyUnavailableReason: readString(record.bodyUnavailableReason),
      sentAt: readString(record.sentAt),
      unread: readBoolean(record.unread, false),
      attachmentCount: typeof record.attachmentCount === 'number' ? record.attachmentCount : 0,
      actionIds: readStringArray(record.actionIds),
      sourceLink: sourceLink(record.sourceLink)
    };
  }

  function normalizeThread(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    if (!address) return null;
    return {
      address: address,
      messageAddresses: readStringArray(record.messageAddresses),
      actionIds: readStringArray(record.actionIds),
      sourceLink: sourceLink(record.sourceLink)
    };
  }

  function normalizeDraft(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    var accountAddress = readString(record.accountAddress);
    if (!address || !accountAddress) return null;
    return {
      address: address,
      accountAddress: accountAddress,
      threadAddress: readString(record.threadAddress),
      to: readStringArray(record.to),
      subject: readString(record.subject),
      body: readString(record.body),
      actionIds: readStringArray(record.actionIds),
      status: normalizeStatus(record.status)
    };
  }

  function normalizeStatus(value) {
    var record = objectOrEmpty(value);
    var address = readString(record.address);
    if (!address) return null;
    return {
      address: address,
      accountAddress: readString(record.accountAddress),
      messageAddress: readString(record.messageAddress),
      label: readStringOr(record.label, 'Needs attention'),
      actionIds: readStringArray(record.actionIds)
    };
  }

  function byId(items) {
    var out = {};
    for (var i = 0; i < items.length; i += 1) out[items[i].address || items[i].id] = items[i];
    return out;
  }

  function compactMap(values, normalizer) {
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var item = normalizer(values[i]);
      if (item) out.push(item);
    }
    return out;
  }

  function readWorkspace(feedValue) {
    var feed = unwrapFeed(feedValue || {});
    var accounts = compactMap(arrayOrEmpty(feed.accounts), normalizeAccount)
      .sort(function (left, right) {
        return left.name.localeCompare(right.name) || left.address.localeCompare(right.address);
      });
    var actions = compactMap(arrayOrEmpty(feed.actions), normalizeAction);
    var actionsById = {};
    for (var a = 0; a < actions.length; a += 1) actionsById[actions[a].id] = actions[a];
    var mailboxes = compactMap(arrayOrEmpty(feed.mailboxes), normalizeMailbox);
    var messages = compactMap(arrayOrEmpty(feed.messages), normalizeMessage);
    var messagesByAddress = byId(messages);
    var threads = compactMap(arrayOrEmpty(feed.threads), normalizeThread);
    var threadByAddress = byId(threads);
    var selectedAddress = readString(feed.selectedAddress);
    var selectedMailboxAddress = readString(feed.selectedMailboxAddress);
    var selectedMessage = selectedAddress ? messagesByAddress[selectedAddress] : null;
    var selectedThreadAddress = selectedMessage ? selectedMessage.threadAddress : selectedAddress;
    var selectedThread = selectedThreadAddress ? threadByAddress[selectedThreadAddress] : null;
    var selectedMessages = [];
    if (selectedThread) {
      for (var i = 0; i < selectedThread.messageAddresses.length; i += 1) {
        var message = messagesByAddress[selectedThread.messageAddresses[i]];
        if (message) selectedMessages.push(message);
      }
    }
    var visibleMessages = selectedMailboxAddress
      ? messages.filter(function (message) { return message.mailboxAddresses.indexOf(selectedMailboxAddress) >= 0; })
      : messages;
    var statuses = compactMap(arrayOrEmpty(feed.statuses), normalizeStatus);
    return {
      accounts: accounts,
      mailboxes: mailboxes,
      messages: visibleMessages,
      selectedThread: selectedThread,
      selectedMessages: selectedMessages,
      drafts: compactMap(arrayOrEmpty(feed.drafts), normalizeDraft),
      actionsById: actionsById,
      statuses: statuses,
      selectedAddress: selectedAddress,
      selectedMailboxAddress: selectedMailboxAddress,
      loading: readBoolean(feed.loading, false),
      emptyReason: accounts.length === 0 ? 'no-accounts' : visibleMessages.length === 0 ? 'no-messages' : null
    };
  }

  function actionRequest(action, source) {
    var input = {
      operation: action.operation,
      action_id: action.id,
      work_item_address: source.workItemAddress,
      account_address: source.accountAddress || undefined,
      thread_address: source.threadAddress || undefined,
      correlation_id: 'email-client-jscore:' + action.id + ':' + Date.now(),
      values: {},
      undo_action_id: action.undoActionId || undefined
    };
    if (action.definitionId) {
      return {
        target: action.target,
        payload: {
          operation: 'execute_definition',
          definition_id: action.definitionId,
          include_steps: false,
          include_output: false,
          input: input
        }
      };
    }
    return { target: action.target, payload: input };
  }

  function actionButton(action, source) {
    if (!action || action.disabledReason) {
      return box({
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 12,
        padding: 8,
        fillWidth: false
      }, [text(action ? action.label : '', 11, 'semibold', 'darkTextSecondary', 1)]);
    }
    return box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 8,
      fillWidth: false,
      press: {
        operation: TARGET_INVOKE_OPERATION,
        payload: actionRequest(action, source)
      }
    }, [text(action.label, 11, 'semibold', 'accent', 1)]);
  }

  function accountMark(account) {
    return box({
      background: account.color || 'darkSurfaceRaised',
      cornerRadius: 10,
      padding: 7,
      fillWidth: false
    }, [text(account.name.slice(0, 2).toUpperCase(), 10, 'bold', 'darkTextPrimary', 1)]);
  }

  function accountRow(account) {
    var note = account.canSend ? 'Ready to send' : 'Read only';
    return box({
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 10
    }, [
      stack('horizontal', 9, [
        accountMark(account),
        stack('vertical', 2, [
          text(account.name, 13, 'semibold', 'darkTextPrimary', 1),
          text(note, 11, 'regular', 'darkTextSecondary', 1)
        ], { fillWidth: true })
      ])
    ]);
  }

  function mailboxRow(mailbox, selected) {
    return box({
      background: selected ? 'darkSurfaceRaised' : 'darkSurface',
      border: selected ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9
    }, [
      stack('horizontal', 8, [
        text(mailbox.label, 12, 'semibold', selected ? 'accent' : 'darkTextPrimary', 1),
        text(String(mailbox.messageAddresses.length), 11, 'regular', 'darkTextSecondary', 1)
      ], { fillWidth: true })
    ]);
  }

  function messageRow(message, selected) {
    var title = message.unread ? message.subject + ' *' : message.subject;
    var meta = [message.sender, message.sentAt].filter(Boolean).join(' · ');
    return box({
      background: selected ? 'darkSurfaceRaised' : 'darkSurface',
      border: selected ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 11
    }, [
      stack('vertical', 4, [
        text(title, 14, 'semibold', 'darkTextPrimary', 2),
        text(meta, 11, 'regular', 'darkTextSecondary', 1),
        text(message.preview, 12, 'regular', 'darkTextSecondary', 2)
      ])
    ]);
  }

  function statusRow(status, workspace) {
    var buttons = [];
    for (var i = 0; i < status.actionIds.length && buttons.length < 2; i += 1) {
      var action = workspace.actionsById[status.actionIds[i]];
      if (action) {
        buttons.push(actionButton(action, {
          workItemAddress: status.address,
          accountAddress: status.accountAddress || null,
          threadAddress: null
        }));
      }
    }
    return box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 14,
      padding: 11
    }, [
      stack('vertical', 8, [
        text(status.label, 12, 'medium', 'darkTextPrimary', 3),
        buttons.length ? stack('horizontal', 7, buttons) : null
      ])
    ]);
  }

  function detailSection(workspace) {
    if (!workspace.selectedThread || !workspace.selectedMessages.length) {
      return box({
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 16,
        padding: 14
      }, [
        text('Select a message', 16, 'semibold', 'darkTextPrimary', 1),
        text('The thread opens here with reply, archive, and follow-up actions.', 12, 'regular', 'darkTextSecondary', 3)
      ]);
    }
    var thread = workspace.selectedThread;
    var first = workspace.selectedMessages[0];
    var actionButtons = [];
    for (var i = 0; i < thread.actionIds.length && actionButtons.length < 4; i += 1) {
      var action = workspace.actionsById[thread.actionIds[i]];
      if (action) {
        actionButtons.push(actionButton(action, {
          workItemAddress: first.address,
          accountAddress: first.accountAddress,
          threadAddress: first.threadAddress
        }));
      }
    }
    var messageBlocks = workspace.selectedMessages.map(function (message) {
      return box({
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 14,
        padding: 11
      }, [
        stack('vertical', 5, [
          text(message.sender, 12, 'semibold', 'darkTextPrimary', 1),
          text(message.body || message.preview || message.bodyUnavailableReason, 12, 'regular', 'darkTextSecondary', 8),
          message.sourceLink ? text(message.sourceLink.label, 10, 'medium', 'accent', 1) : null
        ])
      ]);
    });
    return box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 14
    }, [
      stack('vertical', 10, [
        text(first.subject, 17, 'bold', 'darkTextPrimary', 2),
        text(first.sender, 12, 'regular', 'darkTextSecondary', 1),
        actionButtons.length ? stack('horizontal', 7, actionButtons) : null
      ].concat(messageBlocks))
    ]);
  }

  function draftSection(workspace) {
    if (!workspace.drafts.length) return null;
    var draft = workspace.drafts[0];
    var buttons = [];
    for (var i = 0; i < draft.actionIds.length && buttons.length < 2; i += 1) {
      var action = workspace.actionsById[draft.actionIds[i]];
      if (action) {
        buttons.push(actionButton(action, {
          workItemAddress: draft.address,
          accountAddress: draft.accountAddress,
          threadAddress: draft.threadAddress || null
        }));
      }
    }
    return box({
      background: 'darkSurface',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 14
    }, [
      stack('vertical', 8, [
        text('Draft', 12, 'semibold', 'darkTextSecondary', 1),
        text(draft.subject || 'Untitled draft', 15, 'bold', 'darkTextPrimary', 2),
        text(draft.body, 12, 'regular', 'darkTextSecondary', 4),
        draft.status ? text(draft.status.label, 11, 'medium', 'accent', 2) : null,
        buttons.length ? stack('horizontal', 7, buttons) : null
      ])
    ]);
  }

  function buildSnapshot(workspace) {
    var children = [
      stack('vertical', 3, [
        text('Email', 24, 'bold', 'darkTextPrimary', 1),
        text('Read, reply, schedule, search, and make follow-up work across connected accounts.', 12, 'regular', 'darkTextSecondary', 3)
      ])
    ];

    if (workspace.loading) {
      children.push(text('Loading mail...', 13, 'medium', 'darkTextSecondary', 1));
    }

    for (var s = 0; s < workspace.statuses.length && s < 3; s += 1) {
      children.push(statusRow(workspace.statuses[s], workspace));
    }

    if (workspace.emptyReason === 'no-accounts') {
      children.push(box({
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 18
      }, [
        stack('vertical', 8, [
          text('Connect an email account', 18, 'bold', 'darkTextPrimary', 2),
          text('Start with one account. The workspace keeps the sending account visible before every reply.', 12, 'regular', 'darkTextSecondary', 4)
        ])
      ]));
    } else {
      children.push(stack('vertical', 8, workspace.accounts.slice(0, 3).map(accountRow)));
      children.push(stack('vertical', 7, workspace.mailboxes.slice(0, 6).map(function (mailbox) {
        return mailboxRow(mailbox, mailbox.address === workspace.selectedMailboxAddress);
      })));
      if (workspace.messages.length) {
        children.push(stack('vertical', 8, workspace.messages.slice(0, 12).map(function (message) {
          return messageRow(message, message.address === workspace.selectedAddress);
        })));
      } else {
        children.push(text('No messages in this view yet.', 13, 'medium', 'darkTextSecondary', 1));
      }
      children.push(detailSection(workspace));
      children.push(draftSection(workspace));
    }

    return box({
      background: 'darkBackground',
      padding: 16,
      spacing: 12,
      minHeight: 1
    }, children, 'email-client-jscore-root');
  }

  function readMountFeed(record, mount) {
    var props = objectOrEmpty(record && record.props);
    if (props.feed) return unwrapFeed(props.feed);
    var liveValue = readPackageInput(mount, 'communication-work-items');
    return unwrapFeed(liveValue || {});
  }

  globalThis.bitfieldMount = function bitfieldMount(record, mount) {
    var lifecycle = lifecycleKey(record);
    var workspace = readWorkspace(readMountFeed(record, mount));
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify({
      lifecycle_key: lifecycle,
      root: buildSnapshot(workspace)
    }));
    return {
      dispose: function dispose() {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: lifecycle }));
      }
    };
  };
}());
