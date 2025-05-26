import { useContext } from "react";
import ThemeContext from "../store/todo-context-api";

function Appname() {
  const Theme = useContext(ThemeContext);
  console.log(Theme);

  return (
    <div style={{ fontFamily: "serif" }}>
      <h1>TODO-App</h1>
    </div>
  );
}
export default Appname;
