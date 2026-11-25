import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PhaseView, ProjectDetail, TaskView } from '@heph/schema';
import {
  CheckCircleFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  GrabberIcon,
  PlusIcon,
} from '@primer/octicons-react';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api } from '../../api/client.js';
import { keys, setProjectCache, useApiMutation } from '../../api/queries.js';
import { Button, Dialog, Field, Menu, ProgressBar, Segmented } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';
import { locateTask, movePhase, moveTask, type TaskMove } from './reorder.js';

type Filter = 'open' | 'closed' | 'all';

const phaseKey = (id: number) => `phase-${id}`;
const taskKey = (id: number) => `task-${id}`;
const dropKey = (id: number) => `drop-${id}`;
const idOf = (key: string | number) => Number(String(key).split('-')[1]);

/**
 * Roadmap: exactly two levels (§5). Phases and tasks reorder by drag and drop or with
 * the keyboard (dnd-kit keyboard sensor, plus Move up / down in the ⋯ menus). Moves
 * are applied optimistically and sent to the REST API; polling (D52) shows Claude's
 * changes without reloading.
 */
export function RoadmapBoard({ project }: { project: ProjectDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const ref = project.slug;
  const [filter, setFilter] = useState<Filter>('open');
  const [editing, setEditing] = useState<
    { kind: 'task'; task: TaskView } | { kind: 'phase'; phase: PhaseView } | null
  >(null);
  const [confirm, setConfirm] = useState<
    { kind: 'task'; task: TaskView } | { kind: 'phase'; phase: PhaseView } | null
  >(null);
  const [adding, setAdding] = useState(false);
  const invalidate = () => [keys.project(ref)];

  const phaseMove = useApiMutation((a: { id: number; to: number }) => api.movePhase(a.id, a.to), {
    invalidate,
    optimistic: (a) =>
      setProjectCache(qc, ref, (p) => ({
        ...p,
        phases: movePhase(p.phases, a.id, a.to) ?? p.phases,
      })),
  });
  const taskMove = useApiMutation((m: TaskMove) => api.moveTask(m.taskId, m.position, m.phaseId), {
    invalidate,
    optimistic: (m) =>
      setProjectCache(qc, ref, (p) => ({ ...p, phases: moveTask(p.phases, m) ?? p.phases })),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a.startsWith('phase-')) {
      // `phase-<id>` (sortable) and `drop-<id>` (body) both name a phase; only
      // `task-<id>` needs a lookup. Phase and task ids overlap, never mix them.
      const overPhase = o.startsWith('task-')
        ? locateTask(project.phases, idOf(o))?.phaseId
        : idOf(o);
      const from = project.phases.findIndex((p) => p.id === idOf(a));
      const to = project.phases.findIndex((p) => p.id === overPhase);
      if (to >= 0 && to !== from) phaseMove.mutate({ id: idOf(a), to });
      return;
    }
    const taskId = idOf(a);
    if (o.startsWith('task-')) {
      const at = locateTask(project.phases, idOf(o));
      if (at) taskMove.mutate({ taskId, phaseId: at.phaseId, position: at.index });
    } else {
      // Dropped on a phase (header or empty list): append at its end.
      const phase = project.phases.find((p) => p.id === idOf(o));
      if (phase) {
        const inside = phase.tasks.some((x) => x.id === taskId);
        taskMove.mutate({
          taskId,
          phaseId: phase.id,
          position: inside ? phase.tasks.length - 1 : phase.tasks.length,
        });
      }
    }
  }

  const nextId = project.nextTask?.id ?? null;
  const visible = (task: TaskView) =>
    filter === 'all' || (filter === 'open' ? !task.done : task.done);

  return (
    <div className="roadmap">
      <div className="toolbar">
        <Segmented<Filter>
          label={t('roadmap.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: t('roadmap.filter.open') },
            { value: 'closed', label: t('roadmap.filter.closed') },
            { value: 'all', label: t('roadmap.filter.all') },
          ]}
        />
        <Button onClick={() => setAdding(true)}>
          <PlusIcon size={16} /> {t('roadmap.addPhase')}
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <SortableContext
          items={project.phases.map((p) => phaseKey(p.id))}
          strategy={verticalListSortingStrategy}
        >
          {project.phases.map((phase, pi) => (
            <PhaseBox
              key={phase.id}
              phase={phase}
              index={pi}
              count={project.phases.length}
              nextId={nextId}
              visible={visible}
              projectRef={ref}
              onMove={(to) => phaseMove.mutate({ id: phase.id, to })}
              onMoveTask={(m) => taskMove.mutate(m)}
              onEdit={(x) => setEditing(x)}
              onDelete={(x) => setConfirm(x)}
            />
          ))}
        </SortableContext>
      </DndContext>

      {project.phases.length === 0 && <p className="muted">{t('roadmap.empty')}</p>}

      {adding && <AddPhaseDialog projectRef={ref} onClose={() => setAdding(false)} />}
      {editing && <EditDialog projectRef={ref} target={editing} onClose={() => setEditing(null)} />}
      {confirm && (
        <ConfirmDelete projectRef={ref} target={confirm} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}

function PhaseBox({
  phase,
  index,
  count,
  nextId,
  visible,
  projectRef,
  onMove,
  onMoveTask,
  onEdit,
  onDelete,
}: {
  phase: PhaseView;
  index: number;
  count: number;
  nextId: number | null;
  visible: (t: TaskView) => boolean;
  projectRef: string;
  onMove: (to: number) => void;
  onMoveTask: (m: TaskMove) => void;
  onEdit: (x: { kind: 'phase'; phase: PhaseView } | { kind: 'task'; task: TaskView }) => void;
  onDelete: (x: { kind: 'phase'; phase: PhaseView } | { kind: 'task'; task: TaskView }) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(phase.status !== 'done');
  const sortable = useSortable({ id: phaseKey(phase.id) });
  const drop = useDroppable({ id: dropKey(phase.id) });
  const done = phase.tasks.filter((x) => x.done).length;
  const shown = phase.tasks.filter(visible);
  const current = phase.status === 'in_progress';

  return (
    <section
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`box phase${current ? ' phase-current' : ''}${sortable.isDragging ? ' dragging' : ''}`}
      aria-labelledby={`ph-${phase.id}`}
    >
      <header className="box-head phase-head">
        <button
          type="button"
          className="grip"
          aria-label={t('roadmap.dragPhase', { title: phase.title })}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GrabberIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-label={t(open ? 'roadmap.collapse' : 'roadmap.expand')}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        </button>
        <h3 id={`ph-${phase.id}`} className="phase-title">
          {index + 1} · {phase.title}
        </h3>
        <span className="meta">{t(`phase.status.${phase.status}`)}</span>
        <ProgressBar progress={phase.progress} width={140} />
        <span className="meta">
          {t('roadmap.counts', { closed: done, open: phase.tasks.length - done })}
        </span>
        <Menu
          label={t('roadmap.phaseMenu', { title: phase.title })}
          items={[
            { label: t('roadmap.edit'), onSelect: () => onEdit({ kind: 'phase', phase }) },
            {
              label: t('roadmap.moveUp'),
              onSelect: () => onMove(index - 1),
              disabled: index === 0,
            },
            {
              label: t('roadmap.moveDown'),
              onSelect: () => onMove(index + 1),
              disabled: index === count - 1,
            },
            {
              label: t('roadmap.delete'),
              danger: true,
              onSelect: () => onDelete({ kind: 'phase', phase }),
            },
          ]}
        />
      </header>
      {open && (
        <div className="box-body" ref={drop.setNodeRef}>
          <SortableContext
            items={phase.tasks.map((x) => taskKey(x.id))}
            strategy={verticalListSortingStrategy}
          >
            <ul className="tasks">
              {phase.tasks.map((task, ti) => {
                if (!visible(task)) return null;
                // Move up / down jump over tasks hidden by the filter.
                const vi = shown.indexOf(task);
                const above = shown[vi - 1];
                const below = shown[vi + 1];
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    number={`${index + 1}.${ti + 1}`}
                    isNext={task.id === nextId}
                    up={above?.position ?? null}
                    down={below?.position ?? null}
                    projectRef={projectRef}
                    onMove={(position) =>
                      onMoveTask({ taskId: task.id, phaseId: phase.id, position })
                    }
                    onEdit={() => onEdit({ kind: 'task', task })}
                    onDelete={() => onDelete({ kind: 'task', task })}
                  />
                );
              })}
            </ul>
          </SortableContext>
          {shown.length === 0 && <p className="muted small">{t('roadmap.noTasks')}</p>}
          <AddTaskForm phaseId={phase.id} projectRef={projectRef} />
        </div>
      )}
    </section>
  );
}

function TaskRow({
  task,
  number,
  isNext,
  up,
  down,
  projectRef,
  onMove,
  onEdit,
  onDelete,
}: {
  task: TaskView;
  number: string;
  isNext: boolean;
  /** Position to move to with Move up / down, or null when there is no visible neighbour. */
  up: number | null;
  down: number | null;
  projectRef: string;
  onMove: (position: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const sortable = useSortable({ id: taskKey(task.id) });
  const toggle = useApiMutation(
    () => (task.done ? api.reopenTask(task.id) : api.completeTask(task.id)),
    {
      invalidate: () => [keys.project(projectRef)],
    },
  );
  const setNext = useApiMutation(() => api.setNextTask(projectRef, task.id), {
    invalidate: () => [keys.project(projectRef)],
  });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`task${isNext ? ' task-next' : ''}${sortable.isDragging ? ' dragging' : ''}`}
    >
      <button
        type="button"
        className="grip"
        aria-label={t('roadmap.dragTask', { title: task.title })}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GrabberIcon size={16} />
      </button>
      <button
        type="button"
        className={`task-icon ${task.done ? 'done' : 'open'}`}
        aria-label={t(task.done ? 'roadmap.reopen' : 'roadmap.complete', { title: task.title })}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(undefined)}
      >
        {task.done ? <CheckCircleFillIcon size={16} /> : <CircleIcon size={16} />}
      </button>
      <span className="task-num">{number}</span>
      <span className="task-title">{task.title}</span>
      {isNext && <span className="label label-attention">{t('roadmap.nextLabel')}</span>}
      <Menu
        label={t('roadmap.taskMenu', { title: task.title })}
        items={[
          !task.done && !isNext
            ? { label: t('roadmap.setNext'), onSelect: () => setNext.mutate(undefined) }
            : null,
          { label: t('roadmap.edit'), onSelect: onEdit },
          {
            label: t('roadmap.moveUp'),
            onSelect: () => up !== null && onMove(up),
            disabled: up === null,
          },
          {
            label: t('roadmap.moveDown'),
            onSelect: () => down !== null && onMove(down),
            disabled: down === null,
          },
          { label: t('roadmap.delete'), danger: true, onSelect: onDelete },
        ]}
      />
    </li>
  );
}

function AddTaskForm({ phaseId, projectRef }: { phaseId: number; projectRef: string }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const add = useApiMutation((s: string) => api.addTask(phaseId, { title: s }), {
    invalidate: () => [keys.project(projectRef)],
    onSuccess: () => setTitle(''),
  });
  const id = `add-task-${phaseId}`;
  return (
    <form
      className="add-task"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (title.trim()) add.mutate(title.trim());
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t('roadmap.newTask')}
      </label>
      <input
        id={id}
        value={title}
        maxLength={300}
        placeholder={t('roadmap.newTask')}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={!title.trim() || add.isPending}>
        {t('roadmap.add')}
      </Button>
    </form>
  );
}

function AddPhaseDialog({ projectRef, onClose }: { projectRef: string; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const add = useApiMutation((s: string) => api.addPhase(projectRef, { title: s }), {
    invalidate: () => [keys.project(projectRef)],
    onSuccess: onClose,
  });
  return (
    <FormDialog
      title={t('roadmap.addPhase')}
      onClose={onClose}
      onSubmit={() => title.trim() && add.mutate(title.trim())}
      busy={add.isPending}
      submitLabel={t('roadmap.add')}
    >
      <Field label={t('roadmap.phaseTitle')} htmlFor="new-phase">
        <input
          id="new-phase"
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

function EditDialog({
  projectRef,
  target,
  onClose,
}: {
  projectRef: string;
  target: { kind: 'task'; task: TaskView } | { kind: 'phase'; phase: PhaseView };
  onClose: () => void;
}) {
  const t = useT();
  const initial = target.kind === 'task' ? target.task : target.phase;
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(
    target.kind === 'task' ? target.task.notes : target.phase.description,
  );
  const save = useApiMutation(
    (): Promise<unknown> =>
      target.kind === 'task'
        ? api.updateTask(target.task.id, { title: title.trim(), notes: text })
        : api.updatePhase(target.phase.id, { title: title.trim(), description: text }),
    { invalidate: () => [keys.project(projectRef)], onSuccess: onClose },
  );
  return (
    <FormDialog
      title={t(target.kind === 'task' ? 'roadmap.editTask' : 'roadmap.editPhase')}
      onClose={onClose}
      onSubmit={() => title.trim() && save.mutate(undefined)}
      busy={save.isPending}
      submitLabel={t('common.save')}
    >
      <Field label={t('roadmap.title')} htmlFor="edit-title">
        <input
          id="edit-title"
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        label={t(target.kind === 'task' ? 'roadmap.notes' : 'roadmap.description')}
        htmlFor="edit-text"
      >
        <textarea id="edit-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function ConfirmDelete({
  projectRef,
  target,
  onClose,
}: {
  projectRef: string;
  target: { kind: 'task'; task: TaskView } | { kind: 'phase'; phase: PhaseView };
  onClose: () => void;
}) {
  const t = useT();
  const del = useApiMutation(
    () =>
      target.kind === 'task' ? api.deleteTask(target.task.id) : api.deletePhase(target.phase.id),
    { invalidate: () => [keys.project(projectRef)], onSuccess: onClose },
  );
  const title = target.kind === 'task' ? target.task.title : target.phase.title;
  return (
    <Dialog
      title={t(target.kind === 'task' ? 'roadmap.deleteTaskTitle' : 'roadmap.deletePhaseTitle')}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(undefined)}>
            {t('roadmap.delete')}
          </Button>
        </>
      }
    >
      <p>
        {t(target.kind === 'task' ? 'roadmap.deleteTaskText' : 'roadmap.deletePhaseText', {
          title,
          n: target.kind === 'phase' ? target.phase.tasks.length : 0,
        })}
      </p>
    </Dialog>
  );
}

export function FormDialog({
  title,
  children,
  onClose,
  onSubmit,
  busy,
  submitLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  const t = useT();
  const formId = `form-${title.replace(/\W+/g, '-')}`;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    </Dialog>
  );
}
