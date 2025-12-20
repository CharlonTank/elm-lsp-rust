module TestRemoveVariant exposing (Color(..), Status(..))

{-| Test file for remove variant feature
-}


type Color
    = Red
    | Green
    | Blue
    | Unused


type Status
    = Active
    | Inactive


{-| Only uses Red and Green, not Blue or Unused
-}
colorToString : Color -> String
colorToString color =
    case color of
        Red ->
            "red"

        Green ->
            "green"

        _ ->
            "other"
