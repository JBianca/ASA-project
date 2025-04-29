(define (problem deliver-one)
  (:domain default)
  (:objects
    agent1 - me
    a1 - a  ; another agent (could be none)
    p1 - p
    c1 c2 c3 c4 c5 c6 - c
  )
  (:init
    (at agent1 c1)
    (in p1 c3)
    (is-delivery c6)
    
    ; neighbors
    (neighbourRight c1 c2)
    (neighbourRight c2 c3)
    (neighbourDown c3 c6)
    
    ; no blocked or occupied
  )
  (:goal
    (delivered p1)
  )
)