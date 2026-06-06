---
description: Generate a single-file 3D Rubik's Cube HTML page
---
Create a single-file HTML page using only HTML, CSS, and vanilla JavaScript (no libraries).
Build a centered 3D scene containing a fully functional Rubik’s Cube made of 27 smaller cubies. Each cubie must have correctly colored faces (classic cube colors).
The cube should:

Start idle with a slight 3D perspective view
Include a "Start" button below the scene
When clicked, automatically scramble the cube with random realistic face rotations
Then solve itself step by step using reverse moves or a logical sequence
Each move must animate smoothly with easing (no instant jumps)
Rotations should affect only correct layers (like real cube physics) Animation requirements:
Total loop duration: ~30 seconds
Include phases: scramble → solve → short pause → repeat infinitely
Use smooth cubic-bezier or ease-in-out transitions Visual style:
Dark background (black or gradient)
Glowing cube faces with subtle reflections
Soft shadows and depth for realism
Clean modern UI button with hover animation Extra features:
Allow mouse drag to rotate the entire cube in real time
Maintain transform consistency (no breaking cube structure)
Ensure animation is smooth and optimized Output:
Return complete working code in one HTML file only
No explanation, only code

Save to rubik.html
