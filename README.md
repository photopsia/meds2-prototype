# Medications 2.0 prototype

A clickable prototype of the proposed medication record, built on the real OpenEyes stylesheet so it looks and behaves like the application rather than like a wireframe.

**There is no database behind it.** Everything is held in the browser, seeded with one illustrative patient. Reloading the page resets it. Nothing here writes anywhere.

## Running it

It is three files plus a copy of the OpenEyes front-end assets, and it needs no build step:

```
index.html      markup, using the application's own classes
prototype.css   only what the application does not already provide
prototype.js    all the behaviour
vendor/oe/      a copy of protected/assets/nxblu/dist, so the prototype is portable
```

Open `index.html` over HTTP. A file:// URL mostly works but the SVG sprite for the logo does not load, so from this directory:

```
python3 -m http.server 8777
```

then open <http://localhost:8777/>.

## What to try

- Add a drug the patient is already on, to see the three tiers of conflict detection.
- Set a duration from the Change dialog and watch what it does to the stop date, then edit the date by hand.
- Change a dose on a drug that is already on an issued order.
- Switch role in the top right, from prescriber to nurse, to see prescribing rights change.
- Generate an order, print it, then try to edit it.
- Watch the unsaved-changes bar. Nothing is in the record until the examination is saved.

## Keeping the vendored assets current

`vendor/oe` is a copy, so it goes stale. To refresh it from the repo:

```sh
SRC=../../../../../protected/assets/nxblu/dist
cp $SRC/css/style_openeyes.css vendor/oe/css/
cp -R $SRC/fonts/. vendor/oe/fonts/
cp -R $SRC/svg/.   vendor/oe/svg/
cp $SRC/img/oe-i-e-76x76-6.4.12.png vendor/oe/img/
```

## Where the reasoning lives

The prototype is chapter 7 of the scoping package in the parent directory. `06-prototype.md` walks through it screen by screen and says why each decision was taken; `01-design-model.md` is the model it implements.
