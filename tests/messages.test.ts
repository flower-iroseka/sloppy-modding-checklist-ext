import { describe, expect, it } from 'vitest';
import {
  MSG_GET_USER,
  MSG_OPEN_APP,
  getMessageType,
  isRuntimeMessage,
} from '../src/shared/messages';

/**
 * The content script <-> service worker message protocol: isRuntimeMessage and
 * getMessageType.
 *
 * Page scripts can post into the runtime as well, so the check has to turn away
 * anything that isn't one of ours -- a bogus message must never reach the handler.
 */

describe('内容脚本 ↔ SW 的消息协议', () => {
  it('认得两种消息', () => {
    expect(isRuntimeMessage({ type: MSG_OPEN_APP })).toBe(true);
    expect(isRuntimeMessage({ type: MSG_GET_USER })).toBe(true);
    expect(getMessageType({ type: MSG_GET_USER })).toBe(MSG_GET_USER);
  });

  it('外来/畸形消息一律拒绝（页面脚本也可能往 runtime 丢消息）', () => {
    expect(isRuntimeMessage({ type: 'something-else' })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage(undefined)).toBe(false);
    expect(isRuntimeMessage('mc:get-user')).toBe(false);
    expect(isRuntimeMessage({})).toBe(false);
    expect(isRuntimeMessage({ type: 42 })).toBe(false);
  });
});
