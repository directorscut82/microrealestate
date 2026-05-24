export async function getServerSideProps() {
  return { redirect: { destination: '/signin', permanent: false } };
}

export default function Redirect() {
  return null;
}
