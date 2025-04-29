(define (domain default)

  (:requirements :strips :typing :negative-preconditions :disjunctive-preconditions)

  (:types
    a   ; other agents
    p   ; parcels
    c   ; cells
    me  ; our agent
  )

  (:predicates
    ;; Agent and object positions
    (at ?me - me ?c - c)         ; our agent is at cell c
    (in ?p - p ?c - c)           ; parcel p is at cell c
    (occ ?a - a ?c - c)          ; other agent a is at cell c

    ;; Map properties
    (is-delivery ?c - c)         ; cell c is a delivery point
    (is-blocked ?c - c)          ; cell c is not walkable (blocked)

    ;; Adjacency relations
    (neighbourUp ?c1 - c ?c2 - c)    ; c2 is above c1
    (neighbourDown ?c1 - c ?c2 - c)  ; c2 is below c1
    (neighbourLeft ?c1 - c ?c2 - c)  ; c2 is left of c1
    (neighbourRight ?c1 - c ?c2 - c) ; c2 is right of c1

    ;; Agent state
    (holding ?me - me ?p - p)    ; agent me is holding parcel p
    (delivered ?p - p)           ; parcel p has been delivered
  )

  ;; --- Movement Actions ---

  (:action up
    :parameters (?me - me ?c1 - c ?c2 - c)
    :precondition (and
      (neighbourUp ?c1 ?c2)
      (not (is-blocked ?c2))
      (at ?me ?c1)
      (forall (?a - a) (not (occ ?a ?c2))) ; no other agent in target cell
    )
    :effect (and
      (at ?me ?c2)
      (not (at ?me ?c1))
    )
  )

  (:action down
    :parameters (?me - me ?c1 - c ?c2 - c)
    :precondition (and
      (neighbourDown ?c1 ?c2)
      (not (is-blocked ?c2))
      (at ?me ?c1)
      (forall (?a - a) (not (occ ?a ?c2)))
    )
    :effect (and
      (at ?me ?c2)
      (not (at ?me ?c1))
    )
  )

  (:action right
    :parameters (?me - me ?c1 - c ?c2 - c)
    :precondition (and
      (neighbourRight ?c1 ?c2)
      (not (is-blocked ?c2))
      (at ?me ?c1)
      (forall (?a - a) (not (occ ?a ?c2)))
    )
    :effect (and
      (at ?me ?c2)
      (not (at ?me ?c1))
    )
  )

  (:action left
    :parameters (?me - me ?c1 - c ?c2 - c)
    :precondition (and
      (neighbourLeft ?c1 ?c2)
      (not (is-blocked ?c2))
      (at ?me ?c1)
      (forall (?a - a) (not (occ ?a ?c2)))
    )
    :effect (and
      (at ?me ?c2)
      (not (at ?me ?c1))
    )
  )

  ;; --- Parcel Handling Actions ---

  (:action pickup
    :parameters (?me - me ?p - p ?c - c)
    :precondition (and
      (at ?me ?c)
      (in ?p ?c)
      (not (holding ?me ?p))
    )
    :effect (and
      (holding ?me ?p)
      (not (in ?p ?c))
    )
  )

  (:action putdown
    :parameters (?me - me ?p - p ?c - c)
    :precondition (and
      (at ?me ?c)
      (holding ?me ?p)
      (is-delivery ?c)
    )
    :effect (and
      (not (holding ?me ?p))
      (delivered ?p)
    )
  )
)