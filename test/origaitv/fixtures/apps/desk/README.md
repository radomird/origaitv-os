# Desk

This is a stand-in web app made for a desktop, for testing the phone's d-pad (`daemon/remote-page.ts`). It's made up, and it loads nothing from anywhere.

Its contract tests press the d-pad in its pages. The UI test `remote-page.test.mts` uses the same pages.

- `desktop.html` has links along the top, a row of tiles that scrolls sideways, a search field and a dialog. Like many streaming sites, it hides every focus outline and doesn't touch the arrow keys.
- `next.html` is the page its links open, so Back has somewhere to go.
- `own-keys.html` moves its own highlight with the arrows, like an app made for a TV, and calls preventDefault on them.
- `rows.html` is a home page the way many streaming sites draw theirs. Its cards are divs that show a pointer and can't take focus, and one listener on the document opens what's clicked. Its rows slide sideways, one of them only by its own buttons, which show under a pointer. More rows load as the page scrolls near its end, up to row 10, and a footer with nothing to press is under them.
- `overlay.html` has cards with an empty button over them and the title's link over them too. The last card's link is only hidden text.
- `inner.html` doesn't scroll itself: a menu runs down its left side, and its rows scroll in an area of their own beside it, loading more as they go, up to row 8.
- `consent.html` is a sign-in form with a cookie banner over it: a dark wall across the page and the banner's buttons along the bottom. The email field has the focus under the wall.
- `confirm.html` is a sign-in step in a dialog that says it's modal, with no backdrop, so the page's own links show round it. One of its choices only shows a pointer.
- `backdrop.html` has a picture fixed behind the whole page, which is what's painted in the empty middle of the screen. It covers nothing: a row runs past its right edge, and a button is far below the fold.
