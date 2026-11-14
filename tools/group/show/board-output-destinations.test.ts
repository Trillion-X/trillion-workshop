// packages/group/show/board-output-destinations.test.ts
// Unit tests for board export destinations.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OutputPayload } from '../../ui/show/output-destination';
import {
  clipboardDestination,
  downloadDestination,
  selectableTextDestination,
  getBoardExportDestinations,
  engineTargetDestination,
  getBoardExportDestinationsWithTargets,
} from './board-output-destinations';

// Mock the dependencies
vi.mock('trillion-workshop/tools/ui/show/clipboard/copy-text.ts', () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('../do-work/download-text', () => ({
  downloadText: vi.fn(),
}));

vi.mock('../do-work/request-board-output', () => ({
  requestBoardOutputDelivery: vi.fn(),
}));

import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { downloadText } from '../do-work/download-text';
import { requestBoardOutputDelivery } from '../do-work/request-board-output';

describe('board-output-destinations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clipboardDestination', () => {
    it('has correct metadata', () => {
      expect(clipboardDestination.id).toBe('board-export::clipboard');
      expect(clipboardDestination.label).toBe('Copy to clipboard');
      expect(clipboardDestination.hint).toBeDefined();
    });

    it('delegates to copyTextToClipboard', async () => {
      (copyTextToClipboard as any).mockResolvedValue(true);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: 'test content',
      };

      const result = await clipboardDestination.deliver(payload);
      expect(result).toBe(true);
      expect(copyTextToClipboard).toHaveBeenCalledWith('test content');
    });

    it('returns false when copyTextToClipboard fails', async () => {
      (copyTextToClipboard as any).mockResolvedValue(false);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: 'test content',
      };

      const result = await clipboardDestination.deliver(payload);
      expect(result).toBe(false);
    });

    it('returns false for empty text (fail-closed)', async () => {
      (copyTextToClipboard as any).mockResolvedValue(true);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: '',
      };

      const result = await clipboardDestination.deliver(payload);
      expect(result).toBe(false);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    });
  });

  describe('downloadDestination', () => {
    it('has correct metadata', () => {
      expect(downloadDestination.id).toBe('board-export::download');
      expect(downloadDestination.label).toBe('Download file');
      expect(downloadDestination.hint).toBeDefined();
    });

    it('is fallbackOnly (R43a: never a visible choice next to the working Downloads, kept in the chain)', () => {
      expect(downloadDestination.fallbackOnly).toBe(true);
    });

    it('calls downloadText with correct arguments', async () => {
      (downloadText as any).mockImplementation(() => undefined);

      const payload: OutputPayload = {
        filename: 'export.md',
        mimeType: 'text/markdown',
        text: '# Test\nContent',
      };

      const result = await downloadDestination.deliver(payload);
      expect(result).toBe('requested');
      expect(downloadText).toHaveBeenCalledWith('# Test\nContent', 'export.md', 'text/markdown');
    });

    it('returns false when downloadText throws', async () => {
      (downloadText as any).mockImplementation(() => {
        throw new Error('Download failed');
      });

      const payload: OutputPayload = {
        filename: 'export.md',
        mimeType: 'text/markdown',
        text: 'content',
      };

      const result = await downloadDestination.deliver(payload);
      expect(result).toBe(false);
    });

    it('returns false for empty text (fail-closed)', async () => {
      (downloadText as any).mockImplementation(() => undefined);

      const payload: OutputPayload = {
        filename: 'export.md',
        mimeType: 'text/markdown',
        text: '',
      };

      const result = await downloadDestination.deliver(payload);
      expect(result).toBe(false);
      expect(downloadText).not.toHaveBeenCalled();
    });
  });

  describe('selectableTextDestination', () => {
    it('has correct metadata', () => {
      const mockAskText = vi.fn();
      const dest = selectableTextDestination(mockAskText);
      expect(dest.id).toBe('board-export::selectable-text');
      expect(dest.label).toBe('Show for copy/paste');
      expect(dest.hint).toBeDefined();
    });

    it('calls askText with the content', async () => {
      const mockAskText = vi.fn().mockResolvedValue('selectable content');
      const dest = selectableTextDestination(mockAskText);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: 'selectable content',
      };

      const result = await dest.deliver(payload);
      expect(result).toBe('shown');
      expect(mockAskText).toHaveBeenCalledWith(
        expect.stringContaining('Select this text'),
        'selectable content',
        'Done',
      );
    });

    it('does not confirm delivery when the user dismisses the text', async () => {
      const mockAskText = vi.fn().mockResolvedValue(null);
      const dest = selectableTextDestination(mockAskText);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: 'content',
      };

      const result = await dest.deliver(payload);
      expect(result).toBe('cancelled');
    });

    it('returns false for empty text (fail-closed)', async () => {
      const mockAskText = vi.fn().mockResolvedValue(null);
      const dest = selectableTextDestination(mockAskText);

      const payload: OutputPayload = {
        filename: 'export.txt',
        mimeType: 'text/plain',
        text: '',
      };

      const result = await dest.deliver(payload);
      expect(result).toBe(false);
      expect(mockAskText).not.toHaveBeenCalled();
    });
  });

  describe('getBoardExportDestinations', () => {
    it('returns clipboard, download, and selectable-text destinations', () => {
      const mockAskText = vi.fn();
      const dests = getBoardExportDestinations(mockAskText);

      expect(dests).toHaveLength(3);
      expect(dests[0]?.id).toBe('board-export::clipboard');
      expect(dests[1]?.id).toBe('board-export::download');
      expect(dests[2]?.id).toBe('board-export::selectable-text');
    });

    it('destination set is in preference order (clipboard → download → fallback)', () => {
      const mockAskText = vi.fn();
      const dests = getBoardExportDestinations(mockAskText);

      // Verify order: caller will try them in sequence and stop at first success
      const ids = dests.map((d) => d.id);
      expect(ids).toEqual([
        'board-export::clipboard',
        'board-export::download',
        'board-export::selectable-text',
      ]);
    });
  });

  describe('fail-closed delivery chain', () => {
    it('simulates a complete delivery attempt with fallback', async () => {
      (copyTextToClipboard as any).mockResolvedValue(false); // Clipboard fails
      (downloadText as any).mockImplementation(() => {
        throw new Error('Download unavailable');
      }); // Download fails

      const mockAskText = vi.fn().mockResolvedValue(null); // Fallback succeeds
      const dests = getBoardExportDestinations(mockAskText);

      const payload: OutputPayload = {
        filename: 'test.md',
        mimeType: 'text/markdown',
        text: '# Test',
      };

      let success = false;
      for (const dest of dests) {
        const result = await dest.deliver(payload);
        if (result) {
          success = true;
          break;
        }
      }

      expect(success).toBe(true);
      expect(mockAskText).toHaveBeenCalled(); // Fell back to selectable text
    });

    it('stops at first success (clipboard works, skips download)', async () => {
      (copyTextToClipboard as any).mockResolvedValue(true); // Clipboard succeeds
      (downloadText as any).mockImplementation(() => undefined); // Download would be called
      const mockAskText = vi.fn(); // Fallback would be called

      const dests = getBoardExportDestinations(mockAskText);

      const payload: OutputPayload = {
        filename: 'test.md',
        mimeType: 'text/markdown',
        text: '# Test',
      };

      let successCount = 0;
      for (const dest of dests) {
        const result = await dest.deliver(payload);
        if (result) {
          successCount++;
          break;
        }
      }

      expect(successCount).toBe(1);
      expect(downloadText).not.toHaveBeenCalled(); // Skipped download
      expect(mockAskText).not.toHaveBeenCalled(); // Skipped fallback
    });
  });

  describe('engineTargetDestination', () => {
    const payload: OutputPayload = { filename: 'board.md', mimeType: 'text/markdown', text: '# Board' };

    it('resolves true ONLY on a confirmed file-save (echoed paths)', async () => {
      (requestBoardOutputDelivery as any).mockResolvedValue({ method: 'file-save', paths: ['/work/sample/Downloads/board.md'] });
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      expect(dest.id).toBe('board-export::target::downloads');
      expect(await dest.deliver(payload)).toBe(true);
      expect(requestBoardOutputDelivery).toHaveBeenCalledWith(
        { target: 'compute.process' },
        [{ fileName: 'board.md', mimeType: 'text/markdown', text: '# Board' }],
        expect.any(Number),
      );
    });

    it('fails closed when the save echoed zero paths', async () => {
      (requestBoardOutputDelivery as any).mockResolvedValue({ method: 'file-save', paths: [] });
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      expect(await dest.deliver(payload)).toBe(false);
    });

    it('fails closed when the engine rejects', async () => {
      (requestBoardOutputDelivery as any).mockRejectedValue(new Error('engine down'));
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      expect(await dest.deliver(payload)).toBe(false);
    });

    it('a workflow route confirms on the accepted reply', async () => {
      (requestBoardOutputDelivery as any).mockResolvedValue({ method: 'workflow', paths: [] });
      const dest = engineTargetDestination({ id: 'wf', label: 'Send to owner', route: { target: 'slot::workflow', definitionId: 'action:deliver' } });
      expect(await dest.deliver(payload)).toBe(true);
    });

    it('rejects an empty payload without dispatching', async () => {
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      expect(await dest.deliver({ filename: 'a.md', mimeType: 'text/markdown', text: '' })).toBe(false);
      expect(requestBoardOutputDelivery).not.toHaveBeenCalled();
    });

    it('forwards BYTES for an image payload, not text (R43c — the presenter file-save takes base64 bytes)', async () => {
      (requestBoardOutputDelivery as any).mockResolvedValue({ method: 'file-save', paths: ['/work/sample/Downloads/board.png'] });
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      expect(await dest.deliver({ filename: 'board.png', mimeType: 'image/png', bytes })).toBe(true);
      expect(requestBoardOutputDelivery).toHaveBeenCalledWith(
        { target: 'compute.process' },
        [{ fileName: 'board.png', mimeType: 'image/png', bytes }],
        expect.any(Number),
      );
    });

    it('rejects an image payload with zero-length bytes AND no text (fail-closed)', async () => {
      const dest = engineTargetDestination({ id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } });
      expect(await dest.deliver({ filename: 'e.png', mimeType: 'image/png', bytes: new Uint8Array() })).toBe(false);
      expect(requestBoardOutputDelivery).not.toHaveBeenCalled();
    });
  });

  describe('getBoardExportDestinationsWithTargets', () => {
    it('engine targets lead (builtin Downloads row with zero DATA), fallbacks follow in order', () => {
      const dests = getBoardExportDestinationsWithTargets([], vi.fn());
      expect(dests.map((d) => d.id)).toEqual([
        'board-export::target::downloads',
        'board-export::clipboard',
        'board-export::download',
        'board-export::selectable-text',
      ]);
    });

    it('an output-target-catalog published record adds a destination — one DATA row, zero code', () => {
      const record = { payload: { kind: 'output-target-catalog', targets: [
        { id: 'project', label: 'Project folder', route: { target: 'compute.process', destination_dir: '/work/sample/project' } },
      ] } };
      const dests = getBoardExportDestinationsWithTargets([record], vi.fn());
      const ids = dests.map((d) => d.id);
      expect(ids).toContain('board-export::target::project');
      const project = dests.find((d) => d.id === 'board-export::target::project');
      expect(project?.label).toBe('Project folder');
      expect(project?.hint).toContain('/work/sample/project');
    });
  });
});
