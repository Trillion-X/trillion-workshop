  // A tool's whole row, so an AI can learn from how any tool is written: its invoke, placements, licence class and
  // checks, and the text of its files when it has them. A shared row that is only a screen (`screens` below) is
  // described too, since its own screen is drawn from this row; there is nothing of it to run.
  async function describeTool({ tool_id, share, include_files = true }) {
    if (share !== undefined && !nonempty(share)) throw new WorkshopError('share is the link someone sent you for this tool.');
    const everythingNow = await everything({ only: tool_id, share });
    // A screen that is one of the workspace's own (its row names a surface) is not shelved twice, but it is described:
    // an AI reads what it takes (input_schema, controls) like any other tool's.
    const tool = await toolById(everythingNow, tool_id) ?? everythingNow.screens.find(item => item.id === tool_id)
      ?? everythingNow.shared.tools.find(item => item.id === tool_id && !item.invoke && object(item.screen) && (item.status ?? 'active') === 'active') ?? null;
    if (!tool) throw Object.assign(new WorkshopError(`There is no tool ${tool_id}. find_tool_for_job lists tools by job.`, { tool: 'find_tool_for_job', arguments: { job: '(the job in plain words)' } }), { status: 404 });
    const madeBy = madeByOf(everythingNow, tool);
    const fingerprint = typeof tool.invoke?.files === 'string' ? tool.invoke.files : tool.bytes_fingerprint;
    let files;
    if (include_files && fingerprint && store.readBytes && madeBy !== 'another account') {
      const bytes = await store.readBytes(fingerprint);
      if (bytes) {
        try { files = untarGz(bytes).map(entry => (entry.text !== null ? { name: entry.name, text: entry.text } : { name: entry.name, bytes: entry.size })); }
        catch { files = undefined; }
      }
    }
    // Where it runs decides how its samples run (src/workshop-sample-rules.json); its maker reads where each one stands.
    let rule = null;
    try { rule = tool.invoke ? sampleRuleOf(choosePlacement(tool, everythingNow).place) : null; } catch (error) { if (!(error instanceof WorkshopError)) throw error; }
    return {
      tool_id: tool.id, made_by: madeBy, descriptor: tool, ...(files ? { files } : {}),
      ...(rule ? { sample_rule: { safe: rule.safe, unconnected: rule.unconnected, owed_until: rule.owed_until, readback: rule.readback } } : {}),
      ...(madeBy === 'this account' && tool.invoke ? { samples: await sampleStates(tool) } : {}),
      next_call: madeBy === 'this account' ? { tool: 'save_tool', arguments: { descriptor: '(this descriptor, changed)' } } : tool.invoke ? { tool: 'run_tool', arguments: { tool_id: tool.id, ...(share !== undefined ? { share } : {}), ...RUN_HINT } } : null,
    };
  }
