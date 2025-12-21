module TestRemoveVariant exposing (Color(..), Message(..), Single(..), Status(..), Toggle(..))

{-| Test file for remove variant feature
Testing all 5 usage scenarios:

1.  Constructor blocking - Blue used as constructor
2.  Pattern auto-remove - branches like `Red -> ...`
3.  Variant with args - `Other String` with multiple branches
4.  Useless wildcard - scenario where removing variant makes wildcard useless
5.  Only variant - Single type with 1 variant

-}


type Color
    = Red
    | Green
    | Blue
    | Unused


type Status
    = Active
    | Inactive


type Message
    = TextMsg String
    | ImageMsg String
    | SystemMsg


type Single
    = OnlyOne


{-| Uses Blue as CONSTRUCTOR - should block removal
-}
getDefaultColor : Color
getDefaultColor =
    Blue


{-| Uses Red and Green in PATTERN - can be auto-removed
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


{-| Uses SystemMsg only in pattern - can be auto-removed
-}
isUserMessage : Message -> Bool
isUserMessage msg =
    case msg of
        TextMsg _ ->
            True

        ImageMsg _ ->
            True

        SystemMsg ->
            False


{-| Multiple patterns for TextMsg - all should be removed together
-}
getMessagePreview : Message -> String
getMessagePreview msg =
    case msg of
        TextMsg "hello" ->
            "greeting"

        TextMsg "bye" ->
            "farewell"

        TextMsg content ->
            "text: " ++ content

        ImageMsg _ ->
            "image"

        SystemMsg ->
            "system"


type Toggle
    = On
    | Off


{-| Wildcard only covers Off - removing Off makes wildcard useless
-}
toggleToString : Toggle -> String
toggleToString toggle =
    case toggle of
        On ->
            "on"

        _ ->
            "off"
