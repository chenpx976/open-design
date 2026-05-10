// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { AgentEvent, ChatMessage } from '../../src/types';

function messageWithEvents(events: AgentEvent[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    events,
    startedAt: 1_000,
    endedAt: 3_000,
  };
}

describe('AssistantMessage unfinished todo state', () => {
  afterEach(() => cleanup());

  it('keeps Done for a completed latest TodoWrite fixture', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Ship layout', status: 'completed' }] },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByText('Stopped with unfinished work')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue remaining tasks' })).toBeNull();
  });

  it('shows unfinished state and passes unfinished todos to the continue callback', () => {
    const onContinue = vi.fn();
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Draft layout', status: 'completed' },
                {
                  content: 'Build components',
                  status: 'in_progress',
                  activeForm: 'Building components',
                },
                { content: 'Run QA', status: 'pending' },
              ],
            },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
        onContinueRemainingTasks={onContinue}
      />,
    );

    expect(screen.getByText('Stopped with unfinished work')).toBeTruthy();
    expect(screen.getByText('2 task(s) remain')).toBeTruthy();
    const remainingList = screen.getByText('2 task(s) remain').closest('.unfinished-todos');
    expect(remainingList).not.toBeNull();
    expect(within(remainingList as HTMLElement).getByText('Building components')).toBeTruthy();
    expect(within(remainingList as HTMLElement).getByText('Run QA')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue remaining tasks' }));

    expect(onContinue).toHaveBeenCalledWith([
      {
        content: 'Build components',
        status: 'in_progress',
        activeForm: 'Building components',
      },
      { content: 'Run QA', status: 'pending', activeForm: undefined },
    ]);
  });

  it('hides the continue button on older assistant turns', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Run QA', status: 'pending' }] },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast={false}
        onContinueRemainingTasks={vi.fn()}
      />,
    );

    expect(screen.getByText('Stopped with unfinished work')).toBeTruthy();
    expect(screen.getByText('1 task(s) remain')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue remaining tasks' })).toBeNull();
  });

  it('shows a waiting-output state for a streaming tool without results', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'sleep 1 && echo done' },
          },
        ])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('waiting for output…')).toBeTruthy();
  });

  it('shows a first-output waiting state while only status events exist', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          { kind: 'status', label: 'initializing', detail: 'openai-codex/gpt-5.5' },
          { kind: 'status', label: 'working' },
          { kind: 'status', label: 'thinking' },
        ])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.queryByText('working')).toBeNull();
  });

  it('shows reconnecting instead of the normal working footer during stream recovery', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([{ kind: 'status', label: 'reconnecting', detail: 'retry 1' }])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getAllByText('Reconnecting').length).toBeGreaterThan(0);
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('uses the latest cumulative tool result for a repeated tool id', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'printf stream' },
          },
          {
            kind: 'tool_result',
            toolUseId: 'bash-1',
            content: 'old partial only',
            isError: false,
          },
          {
            kind: 'tool_result',
            toolUseId: 'bash-1',
            content: 'new cumulative output',
            isError: false,
          },
        ])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('new cumulative output')).toBeTruthy();
    expect(screen.queryByText('old partial only')).toBeNull();
  });

  it('keeps completed lowercase Pi write groups expanded', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'write-1',
            name: 'write',
            input: { path: 'index.html' },
          },
          {
            kind: 'tool_result',
            toolUseId: 'write-1',
            content: 'Successfully wrote 1200 bytes to index.html',
            isError: false,
          },
          {
            kind: 'tool_use',
            id: 'write-2',
            name: 'write',
            input: { path: 'styles.css' },
          },
          {
            kind: 'tool_result',
            toolUseId: 'write-2',
            content: 'Successfully wrote 400 bytes to styles.css',
            isError: false,
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );

    expect(
      screen.getByRole('button', { name: /Writing ×2, done/ }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('index.html')).toBeTruthy();
    expect(screen.getByText('styles.css')).toBeTruthy();
  });

  it('keeps streamed question-form nodes stable across partial JSON repair frames', () => {
    const firstFrame =
      '<question-form id="direction" title="选择视觉方向">{"questions":[{"id":"direction","label":"视觉方向","type":"direction-cards","options":["editorial","studio"],"cards":[{"id":"editorial","label":"编辑感","mood":"克制、内容优先","references":["Monocle"],"palette":["#111111","#f4efe6"],"displayFont":"Georgia, serif","bodyFont":"Inter, sans-serif"},{"id":"studio","label":"';
    const regressedFrame =
      '<question-form id="direction" title="选择视觉方向">{"questions":[{"id":"direction","label":"视觉方向","type":"direction-cards","options":["editorial","studio"],"cards":[';
    const secondFrame =
      '<question-form id="direction" title="选择视觉方向">{"questions":[{"id":"direction","label":"视觉方向","type":"direction-cards","options":["editorial","studio"],"cards":[{"id":"editorial","label":"编辑感","mood":"克制、内容优先","references":["Monocle"],"palette":["#111111","#f4efe6"],"displayFont":"Georgia, serif","bodyFont":"Inter, sans-serif"},{"id":"studio","label":"现代极简","mood":"安静、精确","references":["Linear"],"palette":["#0f1115","#2f6feb"],"displayFont":"Inter, sans-serif","bodyFont":"Inter, sans-serif"}]}]}';

    const { container, rerender } = render(
      <AssistantMessage
        message={messageWithEvents([{ kind: 'text', text: firstFrame }])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    const firstNode = container.querySelector('.question-form');
    expect(firstNode).not.toBeNull();
    expect(screen.getByText('编辑感')).toBeTruthy();

    rerender(
      <AssistantMessage
        message={messageWithEvents([{ kind: 'text', text: regressedFrame }])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(container.querySelector('.question-form')).toBe(firstNode);
    expect(screen.getByText('编辑感')).toBeTruthy();

    rerender(
      <AssistantMessage
        message={messageWithEvents([{ kind: 'text', text: secondFrame }])}
        streaming
        projectId="project-1"
        isLast
      />,
    );

    expect(container.querySelector('.question-form')).toBe(firstNode);
    expect(screen.getByText('编辑感')).toBeTruthy();
    expect(screen.getByText('现代极简')).toBeTruthy();
  });
});
