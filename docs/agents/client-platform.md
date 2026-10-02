# Mobile and browser behavior

## Mobile software keyboard (`hooks/useViewportHeight.ts`)
- While an editor has focus and the visual viewport is more than `KEYBOARD_MIN_HEIGHT_PX` (60px) shorter than `innerHeight / scale`, the hook writes `visualViewport.height` to `--app-viewport-height`. Compare against the zoom-corrected height: iOS auto-zoom and pinch zoom shrink the visual viewport on their own, and skipping zoomed pages left the composer behind the keyboard. Smaller shrinks are Safari toolbars.
- WebKit settles the shrunken height only after the keyboard animation, often without another `resize` (bugs.webkit.org 265578), and an IME candidate bar resizes the keyboard with no viewport event at all. Every trigger therefore starts one non-restarting chain of re-reads (`SETTLE_DELAYS_MS`), and composition/input/keyup events on a focused editor count as triggers. Reading once per event kept the full-screen height; the page then scrolled to the caret and `scrollTo(0, 0)` fought the user's finger, which reads as a jittering composer.
- The same check sets `<html data-keyboard-open>`. Under `(max-width: 640px), (pointer: coarse) and (max-height: 500px)` CSS then hides `.chat-input-controls` and `.extension-status-shelf` and drops the bottom safe-area padding the keyboard already covers. Phone landscape is included because it has the least height; tablets keep their controls. `MobilePwaLayout.test.mjs` asserts each targeted class exists on its component, so a rename cannot leave a rule silently dead.

## Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.
