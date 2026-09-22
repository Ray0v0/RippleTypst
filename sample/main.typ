#set document(title: "RippleTypst Sample")
#set page(paper: "a8", margin: 1cm)
#set text(font: "New Computer Modern", size: 10pt)

#align(center)[
  #text(size: 1.4em, weight: "bold")[Hello, RippleTypst]

  #v(0.4em)
  #text(fill: rgb("#32506d"))[Local playground sample]
]

#v(0.6em)

This is a *multi-file* sample. Edit `main.typ` or `notes.typ` in the left tree.

$ e = m c^2 $

#lorem(30)

#include "notes.typ"
