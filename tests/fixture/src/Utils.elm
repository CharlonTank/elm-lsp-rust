module Utils exposing (formatName, greet, helper)

import Types exposing (User)


formatName : String -> String
formatName name =
    String.toUpper name


greet : User -> String
greet user =
    "Hello, " ++ helper user.name ++ "!"


helper : String -> String
helper name =
    formatName name
