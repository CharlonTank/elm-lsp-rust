module FieldRename exposing (..)


type alias Person =
    { name : String
    , email : String
    }


type alias Visitor =
    { name : String
    }


getUsername : Person -> String
getUsername person =
    person.name


updatePerson : Person -> String -> Person
updatePerson person newName =
    { person | name = newName }


createPerson : String -> Person
createPerson n =
    { name = n, email = "default@example.com" }


extractName : Person -> String
extractName { name } =
    name


getVisitorName : Visitor -> String
getVisitorName visitor =
    visitor.name
