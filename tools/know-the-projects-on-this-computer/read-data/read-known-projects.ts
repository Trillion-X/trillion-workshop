// packages/projects/read-data/read-known-projects.ts
//
// Pure package-feed decoder for known project records.

import type { ProjectCardData } from './project-card-types';
import {
  readBooleanPayload,
  readJsonPayload,
  readStringPayload,
} from './read-json-payload';

export interface ProjectOption {
  value: string;
  label: string;
  path: string;
}

function projectIdFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const lastSegment = normalized.split('/').filter(Boolean).pop();
  return lastSegment ?? path;
}

function projectLabelFromId(projectId: string): string {
  return projectId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || projectId;
}

function asBoolean(value: unknown): boolean {
  return readBooleanPayload(value);
}

function asString(value: unknown): string | null {
  return readStringPayload(value);
}

function newProjectCard(id: string): ProjectCardData {
  return {
    id,
    path: '',
    name: projectLabelFromId(id),
    source: 'user_config',
    isGitRepo: false,
    gitStatus: null,
    activeAgentIds: [],
    activeTeamNames: [],
    hasClaudeMemory: false,
    pinned: false,
    hidden: false,
    lastActivityAt: null,
  };
}

export function decodeProjectRegistryFeed(raw: unknown): ProjectOption[] {
  const seen = new Set<string>();
  return decodeProjectsFeed(raw)
    .map((project) => {
      const value = project.id || projectIdFromPath(project.path);
      return {
        value,
        label: project.name || projectLabelFromId(value),
        path: project.path,
      };
    })
    .filter((project) => {
      if (!project.value || seen.has(project.value)) return false;
      seen.add(project.value);
      return true;
    });
}

export function decodeProjectsFeed(raw: unknown): ProjectCardData[] {
  const rows = readProjectRows(raw);

  return rows
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      return readDirectProject(entry as Record<string, unknown>);
    })
    .filter((project): project is ProjectCardData => project !== null)
    .filter((project) => project.path.length > 0)
    .filter((project) => !project.hidden)
    .filter((project) => !project.id || project.id.length > 0);
}

function readProjectRows(raw: unknown): unknown[] {
  const payload = readJsonPayload(raw);
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  const projects = readJsonPayload(record.projects);
  if (Array.isArray(projects)) return projects;
  const items = readJsonPayload(record.items);
  return Array.isArray(items) ? items : [];
}

function readDirectProject(record: Record<string, unknown>): ProjectCardData | null {
  const path = asString(record.path ?? record.project_path);
  const id =
    asString(record.id) ??
    asString(record.project_id) ??
    asString(record.projectId) ??
    (path ? projectIdFromPath(path) : null);
  if (!id || !path) return null;

  const project = newProjectCard(id);
  project.path = path;
  project.name = asString(record.name) ?? projectLabelFromId(projectIdFromPath(path));
  project.hasClaudeMemory = asBoolean(record.hasClaudeMemory ?? record.has_claude_dir);
  project.pinned = asBoolean(record.pinned);
  project.hidden = asBoolean(record.hidden);
  project.lastActivityAt = asString(record.lastActivityAt ?? record.last_activity);

  const source = asString(record.source);
  if (
    source === 'claude_memory' ||
    source === 'git_scan' ||
    source === 'user_config' ||
    source === 'agent_activity'
  ) {
    project.source = source;
  }

  const branch = asString(record.gitBranch ?? record.git_branch);
  const status = asString(record.gitStatus ?? record.git_status);
  const remoteUrl = asString(record.remoteUrl ?? record.remote_url);
  const isGitRepo = asBoolean(record.isGitRepo ?? record.is_git_repo) || source === 'git_scan';
  if (isGitRepo || branch || status || remoteUrl) {
    project.isGitRepo = true;
    project.gitStatus = {
      branch: branch ?? 'unknown',
      dirtyFileCount: status === 'dirty' ? 1 : 0,
      remoteUrl,
      aheadBehind: null,
    };
  }

  return project;
}
