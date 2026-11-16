import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";

const LayoutEditing = createContext<{
  editing: boolean;
  setEditing: Dispatch<SetStateAction<boolean>>;
}>({
  editing: false,
  setEditing: () => {},
});
export function LayoutEditingProvider({ children }: { children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  return (
    <LayoutEditing.Provider value={{ editing, setEditing }}>
      {children}
    </LayoutEditing.Provider>
  );
}
export const useLayoutEditing = () => useContext(LayoutEditing);
