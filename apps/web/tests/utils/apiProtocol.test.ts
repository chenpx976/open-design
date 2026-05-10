import { describe, expect, it } from 'vitest';
import { apiProtocolLabel, apiProtocolModelLabel } from '../../src/utils/apiProtocol';
import {
  agentDisplayName,
  agentModelDisplayName,
  exactAgentDisplayName,
} from '../../src/utils/agentLabels';

describe('api protocol labels', () => {
  it('labels the selected API protocol instead of assuming Anthropic', () => {
    expect(apiProtocolLabel('openai')).toBe('OpenAI API');
    expect(apiProtocolLabel('google')).toBe('Google Gemini');
    expect(apiProtocolLabel(undefined)).toBe('Anthropic API');
  });

  it('includes the selected model when labeling API assistant messages', () => {
    expect(apiProtocolModelLabel('openai', 'google/gemma-4-e4b')).toBe(
      'OpenAI API · google/gemma-4-e4b',
    );
    expect(apiProtocolModelLabel('azure', '  ')).toBe('Azure OpenAI');
  });

  it('includes explicit Pi models when labeling agent messages', () => {
    expect(agentModelDisplayName('pi', 'Pi agent', 'anthropic/claude-sonnet-4-5')).toBe(
      'Pi · anthropic/claude-sonnet-4-5',
    );
    expect(agentModelDisplayName('node:pi-sdk', 'Pi agent', 'default')).toBe('Pi');
  });

  it('normalizes Pi runtime ids and aliases', () => {
    expect(agentDisplayName('pi')).toBe('Pi');
    expect(exactAgentDisplayName('pi sdk')).toBe('Pi');
    expect(exactAgentDisplayName('node:pi-sdk')).toBe('Pi');
    expect(agentDisplayName('/opt/open-design/node:pi-sdk')).toBe('Pi');
  });

  it('includes explicit Pi models but hides the default model', () => {
    expect(agentModelDisplayName('pi-sdk', 'Pi agent', 'openai/gpt-5.4')).toBe('Pi · openai/gpt-5.4');
    expect(agentModelDisplayName('pi-sdk', 'Pi agent', 'default')).toBe('Pi');
  });
});
