module Types exposing (User, defaultUser, Guest, createGuest)


type alias User =
    { name : String
    , email : String
    , age : Int
    }


defaultUser : User
defaultUser =
    { name = "Alice"
    , email = "alice@example.com"
    , age = 30
    }


type alias Guest =
    { nickname : String
    }


createGuest : String -> Guest
createGuest nickname =
    { nickname = nickname }
