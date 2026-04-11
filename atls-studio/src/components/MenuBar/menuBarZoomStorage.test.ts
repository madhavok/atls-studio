/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  ZOOM_STORAGE_KEY,
  loadZoomIndex,
  saveZoomIndex,
} from './menuBarZoomStorage';

describe('menuBarZoomStorage', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns default when storage is empty', () => {
    expect(loadZoomIndex()).toBe(DEFAULT_ZOOM_INDEX);
  });

  it('loads valid saved index', () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, '4');
    expect(loadZoomIndex()).toBe(4);
    expect(ZOOM_LEVELS[4]).toBe(1.25);
  });

  it('ignores out-of-range index', () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(ZOOM_LEVELS.length));
    expect(loadZoomIndex()).toBe(DEFAULT_ZOOM_INDEX);
    localStorage.setItem(ZOOM_STORAGE_KEY, '-1');
    expect(loadZoomIndex()).toBe(DEFAULT_ZOOM_INDEX);
  });

  it('ignores non-numeric saved value', () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, 'abc');
    expect(loadZoomIndex()).toBe(DEFAULT_ZOOM_INDEX);
  });

  it('saveZoomIndex persists string index', () => {
    saveZoomIndex(1);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1');
  });

  it('loadZoomIndex returns default when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadZoomIndex()).toBe(DEFAULT_ZOOM_INDEX);
  });

  it('saveZoomIndex ignores setItem failures', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveZoomIndex(0)).not.toThrow();
  });
});
