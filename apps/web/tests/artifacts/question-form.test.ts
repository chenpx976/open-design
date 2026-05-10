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
});
