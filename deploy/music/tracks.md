# Music for recap videos

Recap videos pick a background track from a folder of music files. The tracks below are free
to use under the [Pixabay Content License](https://pixabay.com/service/license-summary/), with no
credit needed. That licence doesn't allow passing the files on by themselves, so they aren't in
this repo. **MANUAL, optional:** download them yourself. Without music, recaps are silent and
nothing else changes.

## How to add them

1. Open each track's Pixabay page and use its **Download** button. Pixabay blocks scripts, so
   this is done by hand.
2. Save each file under the name in the first column, in `.local/recap-music/tracks/` at the top
   of the repo. Dev and prod both use that folder. For dev, `MUSIC_DIR` in `.env` can point at
   another folder.
3. Prod copies every `.mp3` in that folder to the server on the next deploy.

The start of the file name is its mood. A recap picks among the tracks whose name starts with
a mood that fits it: trips get `adventure` or `upbeat`, big days `festive` or `indian-festive`, a
month's best `upbeat` or `calm`, a person's spotlight `calm` or `indian-calm`, and anything over a
year old `nostalgic` (`memento-extras/src/constants/creations.constants.ts`). You can add your
own tracks the same way: `<mood>-<any name>.mp3`.

## The tracks

The fingerprint (sha256) is of the file as Pixabay served it on 2026-11-22. Check yours with
`shasum -a 256 <file>`. If it differs, Pixabay may have changed the file; it still works.

| Save as | Title | Artist | Pixabay page | sha256 |
|---|---|---|---|---|
| `upbeat-happy-strums.mp3` | Acoustic Upbeat - Happy Strums | Sonican | [link](https://pixabay.com/music/acoustic-group-acoustic-upbeat-happy-strums-270783/) | `3792fc11d758eb1ec72aa84874589ff8def9b3d106ec06177a7d499b013d19f4` |
| `upbeat-happy-mandolin.mp3` | Happy Mandolin | Echobrainz | [link](https://pixabay.com/music/folk-happy-mandolin-637052/) | `2a94f3253c7344d10eb3610cb6e0b8f9b683137344a0696add616767b83ba523` |
| `calm-warm-acoustic.mp3` | Warm Acoustic | AtlasAudio | [link](https://pixabay.com/music/acoustic-group-warm-acoustic-621617/) | `c37897d74498f71b4ddb0f2535dad7e8cae4ac53dc90ebdaa163a762da328425` |
| `nostalgic-piano.mp3` | Nostalgic Piano | AtlasAudio | [link](https://pixabay.com/music/nostalgia-nostalgic-piano-520047/) | `f7f0461d55ab2aa21b48f9a4b341dcf886f4826de776b0607223f2b94e2f0101` |
| `nostalgic-piano-ambient.mp3` | Nostalgic Piano Ambient | Tunetank | [link](https://pixabay.com/music/modern-classical-nostalgic-piano-ambient-349310/) | `2afa63d46603162929355690765d5a943ab82899f95bc07d7ad61eb5a62cb1c6` |
| `festive-happy-birthday.mp3` | Happy Birthday Festive Music | Tunetank | [link](https://pixabay.com/music/special-occasions-happy-birthday-festive-music-414654/) | `eb5462b0d77a92316e813dea7a14af2a975d73abbac69a832180c6f0defb48e1` |
| `adventure-adventure.mp3` | Adventure | AtlasAudio | [link](https://pixabay.com/music/adventure-adventure-636768/) | `f1b263412896331dae81b0d286bcf2b8e3f6c18be29597b070e57d57d137d68b` |
| `indian-festive-wedding-celebration.mp3` | Indian Wedding Celebration | OpenMindAudio | [link](https://pixabay.com/music/india-indian-wedding-celebration-618295/) | `176be73f04090287492c0b054c8c865d029a9dd66b3dde9033ef8ee98fd27433` |
| `indian-calm-sitar-tabla-flute.mp3` | Free Soul Indian Sitar Tabla Flute | kalsstockmedia | [link](https://pixabay.com/music/india-free-soul-indian-sitar-tabla-flute-396347/) | `d83206db87a9420309f62b5239beedaf41194fc2e2b376f4849dbad938899d1c` |
| `indian-calm-saffron-sunrise.mp3` | Indian Background Music - Saffron Sunrise | Diana_Production_Music | [link](https://pixabay.com/music/world-indian-background-music-saffron-sunrise-260413/) | `e1c1c71fe3e41e708223f9af8c423f4a9ad59853f260b8e6168d1e8df85f760f` |
