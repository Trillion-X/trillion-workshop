    // From the summary rows once they are all made (src/connection-summaries.mjs), from the facts until then.
    async list() {
      return { connections: summaries?.filled() ? summaries.rows() : facts.list().map(shown) };
    },
