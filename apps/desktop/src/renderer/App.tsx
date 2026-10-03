import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  DesktopSettings,
  ProjectDto,
  ResourceRow,
  TaskResult,
  WorkflowDto,
} from '../shared/api.js';
import { call, errorText, nexar } from './bridge.js';
import { ApprovalsView } from './components/ApprovalsView.js';
import { ChatView } from './components/ChatView.js';
import { FilesPanel } from './components/FilesPanel.js';
import { ResourcesView } from './components/ResourcesView.js';
import { SettingsView } from './components/SettingsView.js';
import { Sidebar } from './components/Sidebar.js';
import { WorkflowsView } from './components/WorkflowsView.js';
import { sessionStats, type View } from './state.js';
import { applyDensity, applyTheme } from './theme.js';
import { useSessions } from './useSessions.js';
import { useTurns } from './useTurns.js';

const DEFAULT_SETTINGS: DesktopSettings = {
  theme: 'light',
  density: 'comfortable',
  mode: 'cowork',
};
const APPROVAL_POLL_MS = 5000;

function EmptyProjects({ onAdd }: { onAdd: () => void }): ReactElement {
  return (
    <section className="center-empty" data-testid="open-folder-cta">
      <h1>Work on a folder with Nexar</h1>
      <p className="muted">
        Pick a folder for your project. Nexar only works inside folders you add, and saves its
        results as drafts there.
      </p>
      <button type="button" className="btn btn-primary" onClick={onAdd}>
        Open folder as project…
      </button>
    </section>
  );
}

export function App(): ReactElement {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState<readonly ProjectDto[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [filesOpen, setFilesOpen] = useState(true);
  const [resources, setResources] = useState<readonly ResourceRow[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const { turns, start, cancel } = useTurns();

  const project = projects.find((p) => p.id === projectId) ?? null;
  const sessions = useSessions(projectId, settings.mode);
  const sessionDone = sessions.session?.turns.filter((t) => t.state === 'succeeded').length ?? 0;
  const stats = useMemo(() => {
    const base = sessionStats(turns);
    // Conversation turns count as tasks; their cost is not part of the conversation view.
    return {
      ...base,
      tasks: base.tasks + sessionDone,
      partial: base.partial || (base.costUsd !== null && sessionDone > 0),
    };
  }, [turns, sessionDone]);
  const filesRefresh = turns.filter((t) => t.status === 'done').length + sessionDone;

  // First load: settings and projects.
  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([call(nexar.getSettings()), call(nexar.listProjects())]);
        setSettings(s);
        setProjects(p);
        setProjectId(p[0]?.id ?? null);
      } catch (error) {
        setBanner(errorText(error));
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
    applyDensity(settings.density);
  }, [settings.theme, settings.density]);

  const loadResources = useCallback((refresh: boolean) => {
    setResourcesLoading(true);
    call(nexar.listResources({ refresh })).then(
      (rows) => {
        setResources(rows);
        setResourcesError(null);
        setResourcesLoading(false);
      },
      (error: unknown) => {
        setResourcesError(errorText(error));
        setResourcesLoading(false);
      },
    );
  }, []);

  useEffect(() => loadResources(false), [loadResources]);

  const loadPending = useCallback(() => {
    call(nexar.listApprovals({}))
      .then((list) => setPending(list.length))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadPending();
    const timer = setInterval(loadPending, APPROVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [loadPending]);

  const changeSettings = (patch: Partial<DesktopSettings>): void => {
    call(nexar.setSettings(patch)).then(setSettings, (e: unknown) => setBanner(errorText(e)));
  };

  const addProject = (): void => {
    call(nexar.addProject()).then(
      (added) => {
        if (added === null) return;
        setProjects((all) => [...all.filter((p) => p.id !== added.id), added]);
        setProjectId(added.id);
        setView('chat');
        setBanner(null);
      },
      (e: unknown) => setBanner(errorText(e)),
    );
  };

  const removeProject = (id: string): void => {
    call(nexar.removeProject(id)).then(
      () => {
        const rest = projects.filter((p) => p.id !== id);
        setProjects(rest);
        if (projectId === id) setProjectId(rest[0]?.id ?? null);
      },
      (e: unknown) => setBanner(errorText(e)),
    );
  };

  const runWorkflow = (
    workflow: WorkflowDto,
    inputs: Record<string, string | readonly string[]>,
  ): void => {
    if (project === null) return;
    start(project.id, 'workflow', workflow.displayName, (requestId): Promise<TaskResult> =>
      call(
        nexar.runWorkflow({ requestId, projectId: project.id, workflowId: workflow.id, inputs }),
      ),
    );
  };

  const goView = (next: View): void => {
    setView(next);
    if (next === 'resources') loadResources(false);
  };

  const main = ((): ReactElement => {
    switch (view) {
      case 'settings':
        return (
          <SettingsView
            settings={settings}
            projects={projects}
            resources={resources}
            onChange={changeSettings}
          />
        );
      case 'resources':
        return (
          <ResourcesView
            resources={resources}
            loading={resourcesLoading}
            error={resourcesError}
            onRefresh={() => loadResources(true)}
          />
        );
      case 'approvals':
        return <ApprovalsView onChanged={loadPending} />;
      case 'workflows':
        return (
          <WorkflowsView
            project={project}
            turns={turns.filter((t) => t.source === 'workflow' && t.projectId === project?.id)}
            onRun={runWorkflow}
            onCancel={cancel}
          />
        );
      case 'chat':
        return project === null ? (
          <EmptyProjects onAdd={addProject} />
        ) : (
          <ChatView
            mode={settings.mode}
            project={project}
            resources={resources}
            session={sessions.session}
            progress={sessions.progress}
            busy={sessions.busy}
            error={sessions.error}
            filesOpen={filesOpen}
            onToggleFiles={() => setFilesOpen(!filesOpen)}
            onSend={sessions.send}
            onCancel={sessions.cancel}
            onConfirm={sessions.confirmLane}
            onSetMode={sessions.setMode}
            onApprovalsChanged={loadPending}
          />
        );
    }
  })();

  if (!ready) return <div className="boot muted">Starting Nexar…</div>;

  return (
    <div className="app">
      <Sidebar
        mode={settings.mode}
        view={view}
        projects={projects}
        selectedProjectId={projectId}
        pendingApprovals={pending}
        stats={stats}
        conversations={sessions.list}
        selectedConversationId={sessions.selectedId}
        onMode={(mode) => changeSettings({ mode })}
        onView={goView}
        onSelectProject={(id) => {
          setProjectId(id);
          if (view !== 'workflows') setView('chat');
        }}
        onAddProject={addProject}
        onRemoveProject={removeProject}
        onNewConversation={() => {
          setView('chat');
          void sessions.create().then(() => document.getElementById('prompt')?.focus());
        }}
        onSelectConversation={(id) => {
          setView('chat');
          sessions.select(id);
        }}
      />
      <main className="main">
        {banner !== null && (
          <div className="notice notice-bad" role="alert">
            {banner}
          </div>
        )}
        {main}
      </main>
      {view === 'chat' && project !== null && filesOpen && (
        <FilesPanel projectId={project.id} refreshKey={filesRefresh} />
      )}
    </div>
  );
}
