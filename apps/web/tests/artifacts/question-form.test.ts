import { describe, expect, it } from 'vitest';
import { splitOnQuestionForms } from '../../src/artifacts/question-form';

describe('splitOnQuestionForms', () => {
  it('returns a pending form segment while the JSON body is still streaming', () => {
    const segments = splitOnQuestionForms(
      'Pick one:\n<question-form id="direction" title="Pick a visual direction">\n{ "questions": [',
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'Pick one:\n' },
      { kind: 'pending-form', id: 'direction', title: 'Pick a visual direction' },
    ]);
  });

  it('parses a form before the closing tag when the streamed JSON is complete', () => {
    const segments = splitOnQuestionForms(
      '<question-form id="direction" title="Pick a visual direction">{"questions":[{"id":"tone","label":"Tone","type":"radio","options":["A","B"]}]}',
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'form',
      form: {
        id: 'direction',
        title: 'Pick a visual direction',
        questions: [{ id: 'tone', label: 'Tone', type: 'radio', options: ['A', 'B'] }],
      },
    });
  });

  it('renders completed options while the question-form JSON tail is still streaming', () => {
    const segments = splitOnQuestionForms(
      '<question-form id="direction" title="Pick a visual direction">{"questions":[{"id":"tone","label":"Tone","type":"radio","options":["A","B"]}',
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'form',
      form: {
        id: 'direction',
        questions: [{ id: 'tone', label: 'Tone', type: 'radio', options: ['A', 'B'] }],
      },
    });
  });

  it('renders completed direction cards before the next card finishes streaming', () => {
    const segments = splitOnQuestionForms(
      '<question-form id="direction" title="选择视觉方向">{"questions":[{"id":"direction","label":"选择一个方向","type":"direction-cards","options":["editorial","studio"],"cards":[{"id":"editorial","label":"杂志编辑","mood":"清晰、克制、内容优先","references":["Monocle","FT"],"palette":["#111111","#F5F1E8"],"displayFont":"Georgia, serif","bodyFont":"Inter, sans-serif"},{"id":"studio","label":"',
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'form',
      form: {
        id: 'direction',
        title: '选择视觉方向',
        questions: [
          {
            id: 'direction',
            label: '选择一个方向',
            type: 'direction-cards',
            cards: [{ id: 'editorial', label: '杂志编辑' }],
          },
        ],
      },
    });
  });
});
