// A reader this close to the bottom is at the bottom. The slack covers
// fractional scroll positions on zoomed pages.
const AT_BOTTOM_DISTANCE = 1;

// How long a bottom stays reachable after the content grows past it. The
// browser lets a scroll go only as far as the page was tall a frame or two
// ago, so a reader scrolling down lands on a bottom that has just moved.
const RECENT_BOTTOM_MS = 500;

// How long a scroll still counts as the reader's own after their last
// downward wheel turn, finger drag, or key press. It covers smooth scrolling
// and the glide after a swipe.
const READER_INPUT_MS = 1000;

const SCROLL_DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ']);

/**
 * Keeps the conversation at its newest content while the reader follows it.
 *
 * Any upward scroll by the reader stops following at once, however small.
 * Streamed content arrives many times a second and each update scrolls to the
 * bottom, so a scroll up must win from its first pixel or the next update
 * undoes it. Following starts again when the reader scrolls back down to the
 * bottom, or when the app asks for it.
 */
export class BottomFollower {
  private container: HTMLElement;
  private isFollowing = true;
  private lastTop: number;
  private frame: number | undefined;
  private listeners: Array<(following: boolean) => void> = [];
  /** The largest scroll positions measured in the last moments, newest last. */
  private recentBottoms: Array<{ top: number; time: number }> = [];
  private lastScrollDownInput = -Infinity;
  private touchY: number | undefined;
  private draggingScrollbar = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.lastTop = container.scrollTop;
    container.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.watchReaderInput();
  }

  get following() {
    return this.isFollowing;
  }

  /** Call `listener` whenever following starts or stops. */
  onChange(listener: (following: boolean) => void) {
    this.listeners.push(listener);
  }

  /**
   * Call after the content changes. On the next frame this scrolls to the
   * bottom while following, and otherwise measures where the bottom now is.
   */
  scrollToBottom() {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      if (this.isFollowing) this.jumpToBottom();
      else this.recordBottom(this.container.scrollHeight - this.container.clientHeight);
    });
  }

  /** Drop a scroll to the bottom that has not run yet. */
  cancelScroll() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  /** Start or stop following new content without scrolling. */
  setFollowing(following: boolean) {
    if (!following) this.cancelScroll();
    this.lastTop = this.container.scrollTop;
    if (following === this.isFollowing) return;
    this.isFollowing = following;
    for (const listener of this.listeners) listener(following);
  }

  private onScroll() {
    const top = this.container.scrollTop;
    const bottom = this.container.scrollHeight - this.container.clientHeight;
    const distance = bottom - top;
    // When the content gets shorter, the browser moves scrollTop up on its
    // own and the view stays at the bottom. That is not the reader scrolling up.
    if (top < this.lastTop - 1 && distance > AT_BOTTOM_DISTANCE) {
      this.setFollowing(false);
    } else if (distance <= AT_BOTTOM_DISTANCE) {
      this.setFollowing(true);
    } else if (!this.isFollowing && top > this.lastTop && this.readerScrollingDown() && this.reachedRecentBottom(top)) {
      // The reader scrolled down to the bottom, but streamed content has
      // already grown below it. Follow, and catch up with the new content.
      this.setFollowing(true);
      this.scrollToBottom();
    }
    this.lastTop = top;
    this.recordBottom(bottom);
  }

  /**
   * The browser also moves the view down on its own, for example to keep the
   * reading position when older history is inserted above it. Only a scroll
   * the reader is making can reach a bottom.
   */
  private readerScrollingDown() {
    return this.draggingScrollbar || performance.now() - this.lastScrollDownInput < READER_INPUT_MS;
  }

  private reachedRecentBottom(top: number) {
    const since = performance.now() - RECENT_BOTTOM_MS;
    const last = this.recentBottoms.length - 1;
    return this.recentBottoms.some((bottom, i) =>
      (i === last || bottom.time >= since) && top >= bottom.top - AT_BOTTOM_DISTANCE);
  }

  private recordBottom(top: number) {
    const time = performance.now();
    const since = time - RECENT_BOTTOM_MS;
    this.recentBottoms = this.recentBottoms.filter((bottom) => bottom.time >= since);
    this.recentBottoms.push({ top, time });
  }

  private watchReaderInput() {
    const scrollingDown = () => { this.lastScrollDownInput = performance.now(); };
    const options = { passive: true };
    this.container.addEventListener('wheel', (event) => {
      if (event.deltaY > 0) scrollingDown();
    }, options);
    // A finger moving up the screen scrolls the page down.
    this.container.addEventListener('touchstart', (event) => {
      this.touchY = event.touches[0]?.clientY;
    }, options);
    this.container.addEventListener('touchmove', (event) => {
      const y = event.touches[0]?.clientY;
      if (y !== undefined && this.touchY !== undefined && y < this.touchY) scrollingDown();
      this.touchY = y;
    }, options);
    // Scroll keys apply to the conversation unless the reader is typing.
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      if (SCROLL_DOWN_KEYS.has(event.key) && !(event.key === ' ' && event.shiftKey)) scrollingDown();
    });
    // A press on the container itself, rather than on a message, is a press
    // on its scrollbar.
    this.container.addEventListener('pointerdown', (event) => {
      if (event.target === this.container) this.draggingScrollbar = true;
    }, options);
    const stopDragging = () => {
      if (!this.draggingScrollbar) return;
      this.draggingScrollbar = false;
      scrollingDown();
    };
    window.addEventListener('pointerup', stopDragging, options);
    window.addEventListener('pointercancel', stopDragging, options);
  }

  private jumpToBottom() {
    const behavior = this.container.style.scrollBehavior;
    this.container.style.scrollBehavior = 'auto';
    this.container.scrollTop = this.container.scrollHeight;
    this.container.style.scrollBehavior = behavior;
    // The scroll event for this jump arrives later. Recording the position now
    // means a reader scroll up in the same frame still counts as a scroll up.
    this.lastTop = this.container.scrollTop;
  }
}
