import { describe, expect, it, vi } from "vitest";
import { normalizeInventory, readInventory, saveInventory, restoreInventory, STORAGE_KEY } from "../../public/charm-inventory.js";
function storage():Storage{const data=new Map<string,string>();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);},removeItem:k=>{data.delete(k);},clear:()=>data.clear(),key:i=>[...data.keys()][i]??null,get length(){return data.size;}};}
const charm={id:"original",name:"<img src=x onerror=alert(1)>",skills:{"3":2,"99999":1},slots:[2,1,0],weaponSlot:1,source:"game"};
describe("lossless talisman inventory",()=>{
  it("retains weapon skills, slot, unknown IDs and metadata",()=>{expect(normalizeInventory([charm])[0]).toEqual(charm);});
  it("normalizes localized skill names without stripping characters",()=>{const result=normalizeInventory([{...charm,skills:{"見切り":2}}],[{id:3,name:"見切り"}]);expect(result[0].skills).toEqual({"3":2});});
  it("does not silently clamp invalid slots or levels",()=>{expect(()=>normalizeInventory([{...charm,weaponSlot:9}])).toThrow();expect(()=>normalizeInventory([{...charm,skills:{"3":-1}}])).toThrow();});
  it("backs up and restores the previous library",()=>{const s=storage();expect(saveInventory(normalizeInventory([charm]),s)).toBe(true);expect(saveInventory([],s)).toBe(true);expect(restoreInventory(s)[0]).toEqual(charm);});
  it("handles denied storage without crashing or replacing data",()=>{const s=storage();s.setItem(STORAGE_KEY,JSON.stringify([charm]));const denied={...s,setItem:()=>{throw Error("quota");}};expect(saveInventory([],denied)).toBe(false);expect(readInventory(s)[0]).toEqual(charm);vi.stubGlobal("localStorage",undefined);expect(readInventory()).toEqual([]);vi.unstubAllGlobals();});
});
