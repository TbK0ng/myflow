import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowStateBlocks } from '../src/parse-workflow-state.ts';

test('parses all four workflow states from the book', () => {
  const text = [
    '[workflow-state:no_task]',
    'No active task.',
    '[/workflow-state:no_task]',
    '',
    '[workflow-state:planning]',
    'Load `myflow-brainstorm`.',
    'Stay in planning.',
    '[/workflow-state:planning]',
    '',
    '[workflow-state:in_progress]',
    'Flow: implement -> check.',
    '[/workflow-state:in_progress]',
    '',
    '[workflow-state:completed]',
    'Code committed.',
    '[/workflow-state:completed]',
  ].join('\n');

  const blocks = parseWorkflowStateBlocks(text);
  assert.equal(blocks.size, 4);
  assert.equal(blocks.get('no_task'), 'No active task.');
  assert.equal(blocks.get('planning'), 'Load `myflow-brainstorm`.\nStay in planning.');
  assert.equal(blocks.get('in_progress'), 'Flow: implement -> check.');
  assert.equal(blocks.get('completed'), 'Code committed.');
});

test('trims surrounding whitespace from block content', () => {
  const text = '[workflow-state:x]\n\n  hello world  \n\n[/workflow-state:x]';
  const blocks = parseWorkflowStateBlocks(text);
  assert.equal(blocks.get('x'), 'hello world');
});

test('last occurrence wins for duplicate statuses', () => {
  const text = [
    '[workflow-state:x]',
    'first',
    '[/workflow-state:x]',
    '[workflow-state:x]',
    'second',
    '[/workflow-state:x]',
  ].join('\n');
  const blocks = parseWorkflowStateBlocks(text);
  assert.equal(blocks.get('x'), 'second');
});

test('returns empty map for text with no blocks', () => {
  assert.equal(parseWorkflowStateBlocks('no blocks here').size, 0);
});

test('ignores malformed blocks with mismatched closing tag', () => {
  const text = '[workflow-state:x]\ncontent[/workflow-state:y]';
  assert.equal(parseWorkflowStateBlocks(text).size, 0);
});

test('supports CRLF line endings', () => {
  const text = '[workflow-state:x]\r\ncontent\r\n[/workflow-state:x]';
  const blocks = parseWorkflowStateBlocks(text);
  assert.equal(blocks.get('x'), 'content');
});
