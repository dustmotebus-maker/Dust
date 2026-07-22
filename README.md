# Pac-Man

A self-contained browser Pac-Man clone in plain HTML/CSS/JavaScript — no build step, no dependencies.

## Play

Open `index.html` in a browser, or serve the folder locally:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`.

## Controls

- Arrow keys / WASD — move
- P — pause
- On touch devices, an on-screen D-pad appears automatically

## Features

- Procedurally generated, fully-connected maze with a wraparound side tunnel
- Four ghosts (Blinky, Pinky, Inky, Clyde) with distinct chase behaviors and scatter/chase mode switching
- Power pellets that trigger a frightened mode where ghosts can be eaten for escalating bonus points
- Score, lives, level progression (speed increases each level), and a persisted high score (localStorage)
- Mobile-friendly touch controls
