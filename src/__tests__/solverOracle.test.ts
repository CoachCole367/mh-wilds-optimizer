import { describe, expect, it } from "vitest";
import { optimizeBuilds } from "../optimizer";
import { sampleNormalizedData } from "./fixtures/samplePayload";
import type { ArmorKind, OptimizeWorkerRequest } from "../types";

describe("search versus independent exhaustive feasibility oracle",()=>{
  it("matches small inventories across targets and missing allowances",()=>{
    for(let target=1;target<=5;target++)for(let missing=0;missing<=2;missing++)for(let stock=0;stock<=2;stock++){
      const data=structuredClone(sampleNormalizedData),kinds:ArmorKind[]=["head","chest","arms","waist","legs"];
      data.armorSetsById={};data.charmRanks=[{id:0,charmId:0,name:"Empty",rarity:0,level:0,skills:{},slots:[]}];
      kinds.forEach((kind,i)=>{const p=data.armorByKind[kind][0];data.armorByKind[kind]=[{...p,skills:i===0?{1:1}:{},slots:i<2?[1]:[],armorSetId:null}];});
      data.decorations=[{id:900,name:"One point",kind:"armor",slotReq:1,skills:{1:1}}];
      // The oracle enumerates each real slot as empty or occupied; no optimizer helpers are used.
      let oracle=false;
      for(const first of [0,1])for(const second of [0,1]){
        if(first+second>stock)continue;
        if(Math.max(0,target-(1+first+second))<=missing)oracle=true;
      }
      const request:OptimizeWorkerRequest={data,desiredSkills:[{skillId:1,level:target}],allowAlpha:true,allowGamma:true,useAllDecorations:true,allowedDecorationIds:[],decorationCounts:{900:stock},allowedHeadIds:[data.armorByKind.head[0].id],maxResults:1,includeNearMissResults:missing>0,maxMissingPoints:missing};
      expect(optimizeBuilds(request).results.length>0,`target ${target}, missing ${missing}, stock ${stock}`).toBe(oracle);
    }
  });
});
