module Main exposing (main)

import Browser
import Html exposing (Html, div, text)
import Types exposing (User, defaultUser)
import Utils exposing (formatName, greet)


main : Program () Model Msg
main =
    Browser.sandbox
        { init = init
        , update = update
        , view = view
        }


type alias Model =
    { user : User
    , count : Int
    }


type Msg
    = Increment
    | Decrement


init : Model
init =
    { user = defaultUser
    , count = 0
    }


update : Msg -> Model -> Model
update msg model =
    case msg of
        Increment ->
            { model | count = model.count + 1 }

        Decrement ->
            { model | count = model.count - 1 }


view : Model -> Html Msg
view model =
    div []
        [ text (greet model.user)
        , text (" - Count: " ++ String.fromInt model.count)
        , text (" - Formatted: " ++ formatName model.user.name)
        ]
