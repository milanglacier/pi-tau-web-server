// A reader this close to the bottom is at the bottom. The slack covers
// fractional scroll positions on zoomed pages.
const AT_BOTTOM_DISTANCE = 1;

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

  constructor(container: HTMLElement) {
    this.container = container;
    this.lastTop = container.scrollTop;
    container.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }

  get following() {
    return this.isFollowing;
  }

  /** Call `listener` whenever following starts or stops. */
  onChange(listener: (following: boolean) => void) {
    this.listeners.push(listener);
  }

  /** Scroll to the bottom on the next frame, unless the reader stops following first. */
  scrollToBottom() {
    if (!this.isFollowing || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      if (this.isFollowing) this.jumpToBottom();
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
    const distance = this.container.scrollHeight - top - this.container.clientHeight;
    // When the content gets shorter, the browser moves scrollTop up on its
    // own and the view stays at the bottom. That is not the reader scrolling up.
    if (top < this.lastTop - 1 && distance > AT_BOTTOM_DISTANCE) this.setFollowing(false);
    else if (distance <= AT_BOTTOM_DISTANCE) this.setFollowing(true);
    this.lastTop = top;
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
