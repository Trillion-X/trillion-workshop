    setting(name) {
      return eeaf.read(`setting:${name}`)?.value ?? null;
    },
    setSetting(name, value, context = {}) {
      eeaf.write([{ id: `setting:${name}`, type: 'setting', value: value === null ? null : { value } }], { actor: { by: 'trillion' }, ...context });
      return value;
    },
    settings(prefix = '') {
      const rootPrefix = `setting:${prefix}`;
      // Both record engines seek the literal prefix. The filter keeps the setting-name boundary explicit.
      return eeaf.ids('setting', { prefix: rootPrefix }).filter(id => id.startsWith(rootPrefix)).map(id => ({ name: id.slice('setting:'.length), value: eeaf.read(id)?.value ?? null }));
    },
